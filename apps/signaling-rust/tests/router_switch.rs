//! Room switches use an in-memory router: no sockets, clocks or Redis needed.
mod support;
use std::sync::Arc;

use gomoku_signaling::config::{Config, ConfigSnapshot};
use gomoku_signaling::metrics::Metrics;
use gomoku_signaling::protocol::ServerMsg;
use gomoku_signaling::relay::RelayManager;
use gomoku_signaling::rooms::{outbound_channel, ConnHandle, PeerId, RoomCode, RoomTable};
use gomoku_signaling::transport::{ConnCtx, ConnDeps, ConnectionRegistry, Router, SeatRegistry};
use support::fake_relay::{FakeCluster, FakeRelay};
use tokio::sync::{mpsc, Notify};

fn context(id: u64) -> (ConnCtx, mpsc::Receiver<ServerMsg>) {
    let peer = PeerId::new(&format!("peer{id:04}")).unwrap();
    let (tx, rx) = outbound_channel(32);
    let handle = ConnHandle::new(peer.clone(), Arc::from("test"), tx, Arc::new(Notify::new()));
    (ConnCtx::new(id, peer, Arc::from("test"), handle), rx)
}

fn dependencies() -> ConnDeps {
    ConnDeps {
        lobby: Arc::new(tokio::sync::Mutex::new(
            gomoku_signaling::transport::lobby::Lobby::default(),
        )),
        cfg: Arc::new(ConfigSnapshot::new(Config::default())),
        rooms: Arc::new(RoomTable::default()),
        conns: Arc::new(ConnectionRegistry::new(100, 100)),
        relay: Arc::new(RelayManager::disabled("test")),
        metrics: Arc::new(Metrics::new()),
        seats: Arc::new(SeatRegistry::new(60000)),
        node_id: Arc::from("test"),
    }
}

#[tokio::test]
async fn host_leave_promotes_the_remaining_seat_before_notifying_it() {
    let deps = dependencies();
    let router = Router::new(deps.clone());
    let (host, _host_rx) = context(1);
    let (guest, mut guest_rx) = context(2);
    router
        .handle(&host, r#"{"t":"create","room":"AB12"}"#)
        .await;
    router.handle(&guest, r#"{"t":"join","room":"AB12"}"#).await;
    guest_rx.try_recv().unwrap();

    router.handle(&host, r#"{"t":"leave"}"#).await;

    let left: serde_json::Value =
        serde_json::from_str(&guest_rx.try_recv().unwrap().encode()).unwrap();
    assert_eq!(left["role"], "host");
    assert_eq!(
        deps.seats.peek(&guest.peer_id()).unwrap().role,
        gomoku_signaling::transport::SeatRole::Host
    );
}

#[tokio::test]
async fn promoted_guest_resumes_as_host_without_losing_its_credential() {
    let deps = dependencies();
    let router = Router::new(deps.clone());
    let (host, _host_rx) = context(1);
    let (guest, _guest_rx) = context(2);
    let (restored, mut restored_rx) = context(3);
    router
        .handle(&host, r#"{"t":"create","room":"AB12"}"#)
        .await;
    router.handle(&guest, r#"{"t":"join","room":"AB12"}"#).await;
    let seat = deps.seats.peek(&guest.peer_id()).unwrap();
    router.handle(&host, r#"{"t":"leave"}"#).await;
    let resume = serde_json::json!({"t":"resume","room":"AB12","peerId":seat.peer_id.as_str(),"token":seat.token});

    router.handle(&restored, &resume.to_string()).await;

    let resumed: serde_json::Value =
        serde_json::from_str(&restored_rx.try_recv().unwrap().encode()).unwrap();
    assert_eq!(resumed["t"], "resumed");
    assert_eq!(resumed["role"], "host");
    assert_eq!(resumed["peerPresent"], false);
}

#[tokio::test]
async fn cross_node_departure_persists_promotion_for_local_and_remote_resume() {
    let cluster = FakeCluster::new();
    let mut a = dependencies();
    let mut b = dependencies();
    let mut c = dependencies();
    for (deps, name) in [(&mut a, "node-a"), (&mut b, "node-b"), (&mut c, "node-c")] {
        deps.node_id = Arc::from(name);
        deps.relay = FakeRelay::new(name, cluster.clone(), deps.rooms.clone());
    }
    let ra = Router::new(a.clone());
    let rb = Router::new(b.clone());
    let rc = Router::new(c.clone());
    let (host, _host_rx) = context(1);
    let (guest, mut guest_rx) = context(2);
    let (restored, mut restored_rx) = context(3);
    ra.handle(&host, r#"{"t":"create","room":"AB12"}"#).await;
    rb.handle(&guest, r#"{"t":"join","room":"AB12"}"#).await;
    guest_rx.try_recv().unwrap();
    let seat = b.seats.peek(&guest.peer_id()).unwrap();

    ra.handle(&host, r#"{"t":"leave"}"#).await;

    let left: serde_json::Value =
        serde_json::from_str(&guest_rx.try_recv().unwrap().encode()).unwrap();
    assert_eq!(left["role"], "host");
    assert_eq!(
        b.seats.peek(&guest.peer_id()).unwrap().role,
        gomoku_signaling::transport::SeatRole::Host
    );
    assert_eq!(cluster.seats.lock().unwrap()["AB12:peer0002"].role, "host");
    let resume = serde_json::json!({"t":"resume","room":"AB12","peerId":seat.peer_id.as_str(),"token":seat.token});
    rc.handle(&restored, &resume.to_string()).await;
    let resumed: serde_json::Value =
        serde_json::from_str(&restored_rx.try_recv().unwrap().encode()).unwrap();
    assert_eq!(resumed["role"], "host");
}

#[tokio::test]
async fn cross_node_role_notification_targets_only_the_surviving_member() {
    let cluster = FakeCluster::new();
    let mut a = dependencies();
    let mut b = dependencies();
    a.node_id = Arc::from("node-a");
    b.node_id = Arc::from("node-b");
    let relay = FakeRelay::new("node-a", cluster.clone(), a.rooms.clone());
    a.relay = relay.clone();
    b.relay = FakeRelay::new("node-b", cluster, b.rooms.clone());
    let ra = Router::new(a);
    let rb = Router::new(b);
    let (host, _host_rx) = context(1);
    let (guest, _guest_rx) = context(2);
    ra.handle(&host, r#"{"t":"create","room":"AB12"}"#).await;
    rb.handle(&guest, r#"{"t":"join","room":"AB12"}"#).await;

    ra.handle(&host, r#"{"t":"leave"}"#).await;

    let messages = relay.published_messages();
    let left = messages
        .iter()
        .find(|msg| msg.kind == gomoku_signaling::relay::CrossKind::PeerLeft)
        .unwrap();
    assert_eq!(left.target.as_deref(), Some(guest.peer_id().as_str()));
}

#[tokio::test]
async fn cross_node_replacement_retires_the_previous_local_seat() {
    let cluster = FakeCluster::new();
    let mut a = dependencies();
    let mut b = dependencies();
    a.node_id = Arc::from("node-a");
    b.node_id = Arc::from("node-b");
    a.relay = FakeRelay::new("node-a", cluster.clone(), a.rooms.clone());
    b.relay = FakeRelay::new("node-b", cluster.clone(), b.rooms.clone());
    let ra = Router::new(a.clone());
    let rb = Router::new(b);
    let (host, _host_rx) = context(1);
    let (old_guest, _old_rx) = context(2);
    let (restored, _restored_rx) = context(3);
    ra.handle(&host, r#"{"t":"create","room":"AB12"}"#).await;
    ra.handle(&old_guest, r#"{"t":"join","room":"AB12"}"#).await;
    let seat = a.seats.peek(&old_guest.peer_id()).unwrap();
    let resume = serde_json::json!({"t":"resume","room":"AB12","peerId":seat.peer_id.as_str(),"token":seat.token});
    rb.handle(&restored, &resume.to_string()).await;

    gomoku_signaling::transport::connection::on_disconnect(&a, &old_guest).await;

    assert!(a.seats.peek(&old_guest.peer_id()).is_none());
    assert_eq!(
        cluster.seats.lock().unwrap()["AB12:peer0002"].offline_since,
        0
    );
}

#[tokio::test]
async fn late_cross_node_disconnect_cannot_promote_a_new_guest_or_clear_the_new_game() {
    let cluster = FakeCluster::new();
    let mut a = dependencies();
    let mut b = dependencies();
    a.node_id = Arc::from("node-a");
    b.node_id = Arc::from("node-b");
    a.relay = FakeRelay::new("node-a", cluster.clone(), a.rooms.clone());
    b.relay = FakeRelay::new("node-b", cluster, b.rooms.clone());
    let ra = Router::new(a.clone());
    let rb = Router::new(b);
    let (host, mut host_rx) = context(1);
    let (old_guest, _old_rx) = context(2);
    let (restored, _restored_rx) = context(3);
    let (next_guest, mut next_rx) = context(4);
    ra.handle(&host, r#"{"t":"create","room":"AB12"}"#).await;
    ra.handle(&old_guest, r#"{"t":"join","room":"AB12"}"#).await;
    let seat = a.seats.peek(&old_guest.peer_id()).unwrap();
    let resume = serde_json::json!({"t":"resume","room":"AB12","peerId":seat.peer_id.as_str(),"token":seat.token});
    rb.handle(&restored, &resume.to_string()).await;
    gomoku_signaling::transport::connection::on_disconnect(&a, &old_guest).await;
    rb.handle(&restored, r#"{"t":"leave"}"#).await;
    ra.handle(&next_guest, r#"{"t":"join","room":"AB12"}"#)
        .await;
    while host_rx.try_recv().is_ok() {}
    while next_rx.try_recv().is_ok() {}

    for expired in a.seats.sweep(u64::MAX) {
        gomoku_signaling::transport::router::do_leave(&a, &expired.peer_id, &expired.room).await;
    }

    assert_eq!(
        a.seats.peek(&next_guest.peer_id()).unwrap().role,
        gomoku_signaling::transport::SeatRole::Guest
    );
    assert!(host_rx.try_recv().is_err());
    assert!(next_rx.try_recv().is_err());
}

#[tokio::test]
async fn repeated_cross_node_leave_does_not_broadcast_a_departure() {
    let cluster = FakeCluster::new();
    let mut a = dependencies();
    let mut b = dependencies();
    a.node_id = Arc::from("node-a");
    b.node_id = Arc::from("node-b");
    let relay = FakeRelay::new("node-a", cluster.clone(), a.rooms.clone());
    a.relay = relay.clone();
    b.relay = FakeRelay::new("node-b", cluster, b.rooms.clone());
    let ra = Router::new(a.clone());
    let rb = Router::new(b);
    let (host, _host_rx) = context(1);
    let (guest, _guest_rx) = context(2);
    ra.handle(&host, r#"{"t":"create","room":"AB12"}"#).await;
    rb.handle(&guest, r#"{"t":"join","room":"AB12"}"#).await;
    ra.handle(&host, r#"{"t":"leave"}"#).await;
    let before = relay.published_messages().len();

    gomoku_signaling::transport::router::do_leave(
        &a,
        &host.peer_id(),
        &RoomCode::new("AB12").unwrap(),
    )
    .await;

    assert_eq!(relay.published_messages().len(), before);
}

#[tokio::test]
async fn repeated_local_leave_has_no_notifications_or_role_changes() {
    let deps = dependencies();
    let router = Router::new(deps.clone());
    let (host, _host_rx) = context(1);
    let (guest, mut guest_rx) = context(2);
    router
        .handle(&host, r#"{"t":"create","room":"AB12"}"#)
        .await;
    router.handle(&guest, r#"{"t":"join","room":"AB12"}"#).await;
    guest_rx.try_recv().unwrap();

    gomoku_signaling::transport::router::do_leave(
        &deps,
        &PeerId::new("missing0").unwrap(),
        &RoomCode::new("AB12").unwrap(),
    )
    .await;

    assert_eq!(
        deps.seats.peek(&guest.peer_id()).unwrap().role,
        gomoku_signaling::transport::SeatRole::Guest
    );
    assert!(guest_rx.try_recv().is_err());
}

async fn assert_rejected_switch_preserves_original(raw: &str) {
    let deps = dependencies();
    let router = Router::new(deps.clone());
    let (ctx, mut rx) = context(1);
    router.handle(&ctx, r#"{"t":"create","room":"AB12"}"#).await;
    rx.try_recv().unwrap();
    let original_seat = deps.seats.peek(&ctx.peer_id()).unwrap();

    router.handle(&ctx, raw).await;

    assert!(matches!(rx.try_recv().unwrap(), ServerMsg::Error { .. }));
    let original = RoomCode::new("AB12").unwrap();
    assert_eq!(ctx.current_room(), Some(original.clone()));
    assert_eq!(deps.rooms.len_of(&original), 1);
    assert_eq!(
        deps.seats.peek(&ctx.peer_id()).unwrap().token,
        original_seat.token
    );
}

#[tokio::test]
async fn missing_join_preserves_original_room_and_seat() {
    assert_rejected_switch_preserves_original(r#"{"t":"join","room":"ZZZZ"}"#).await;
}

#[tokio::test]
async fn malformed_join_preserves_original_room_and_seat() {
    assert_rejected_switch_preserves_original(r#"{"t":"join","room":"!"}"#).await;
}

#[tokio::test]
async fn malformed_create_preserves_original_room_and_seat() {
    assert_rejected_switch_preserves_original(r#"{"t":"create","room":"!"}"#).await;
}

#[tokio::test]
async fn duplicate_create_preserves_original_room_and_seat() {
    assert_rejected_switch_preserves_original(r#"{"t":"create","room":"AB12"}"#).await;
}

#[tokio::test]
async fn repeated_join_preserves_original_room_and_seat() {
    assert_rejected_switch_preserves_original(r#"{"t":"join","room":"AB12"}"#).await;
}

#[tokio::test]
async fn full_target_preserves_original_room() {
    let deps = dependencies();
    let router = Router::new(deps.clone());
    let (a, mut ra) = context(1);
    let (b, _rb) = context(2);
    let (c, _rc) = context(3);
    router.handle(&a, r#"{"t":"create","room":"AB12"}"#).await;
    ra.try_recv().unwrap();
    router.handle(&b, r#"{"t":"create","room":"CD34"}"#).await;
    router.handle(&c, r#"{"t":"join","room":"CD34"}"#).await;

    router.handle(&a, r#"{"t":"join","room":"CD34"}"#).await;

    assert!(matches!(ra.try_recv().unwrap(), ServerMsg::Error { .. }));
    assert_eq!(a.current_room(), Some(RoomCode::new("AB12").unwrap()));
    assert_eq!(deps.rooms.len_of(&RoomCode::new("AB12").unwrap()), 1);
    assert_eq!(deps.rooms.len_of(&RoomCode::new("CD34").unwrap()), 2);
}

#[tokio::test]
async fn successful_join_leaves_previous_room_and_installs_target_seat() {
    let deps = dependencies();
    let router = Router::new(deps.clone());
    let (a, mut ra) = context(1);
    let (b, _rb) = context(2);
    router.handle(&a, r#"{"t":"create","room":"AB12"}"#).await;
    ra.try_recv().unwrap();
    router.handle(&b, r#"{"t":"create","room":"CD34"}"#).await;

    router.handle(&a, r#"{"t":"join","room":"CD34"}"#).await;

    assert!(matches!(ra.try_recv().unwrap(), ServerMsg::Joined { .. }));
    assert!(!deps.rooms.contains(&RoomCode::new("AB12").unwrap()));
    assert_eq!(a.current_room(), Some(RoomCode::new("CD34").unwrap()));
    assert_eq!(deps.rooms.len_of(&RoomCode::new("CD34").unwrap()), 2);
    assert_eq!(
        deps.seats.peek(&a.peer_id()).unwrap().room,
        RoomCode::new("CD34").unwrap()
    );
}

async fn restored_pair() -> (ConnDeps, Router, ConnCtx, ConnCtx) {
    let deps = dependencies();
    let router = Router::new(deps.clone());
    let (old, _old_rx) = context(1);
    let (restored, _restored_rx) = context(2);
    router.handle(&old, r#"{"t":"create","room":"AB12"}"#).await;
    let seat = deps.seats.peek(&old.peer_id()).unwrap();
    let resume = serde_json::json!({"t":"resume","room":"AB12","peerId":seat.peer_id.as_str(),"token":seat.token});
    router.handle(&restored, &resume.to_string()).await;
    assert!(deps.seats.is_owner(&restored.peer_id(), restored.conn_id));
    (deps, router, old, restored)
}

#[tokio::test]
async fn superseded_socket_cannot_create_after_its_room_was_cleared() {
    let (deps, router, old, restored) = restored_pair().await;
    let token = deps.seats.peek(&restored.peer_id()).unwrap().token;
    router.handle(&old, r#"{"t":"leave"}"#).await;
    for _ in 0..2 {
        router.handle(&old, r#"{"t":"create","room":"CD34"}"#).await;
    }
    assert!(!deps.rooms.contains(&RoomCode::new("CD34").unwrap()));
    assert!(deps.seats.is_owner(&restored.peer_id(), restored.conn_id));
    assert_eq!(deps.seats.peek(&restored.peer_id()).unwrap().token, token);
}

#[tokio::test]
async fn superseded_socket_cannot_join_after_a_ping_cleared_its_room() {
    let (deps, router, old, restored) = restored_pair().await;
    let (target, _target_rx) = context(3);
    router
        .handle(&target, r#"{"t":"create","room":"CD34"}"#)
        .await;
    router.handle(&old, r#"{"t":"ping","ts":1}"#).await;
    for _ in 0..2 {
        router.handle(&old, r#"{"t":"join","room":"CD34"}"#).await;
    }
    assert_eq!(deps.rooms.len_of(&RoomCode::new("CD34").unwrap()), 1);
    assert!(deps.seats.is_owner(&restored.peer_id(), restored.conn_id));
    assert_eq!(
        restored.current_room(),
        Some(RoomCode::new("AB12").unwrap())
    );
}
