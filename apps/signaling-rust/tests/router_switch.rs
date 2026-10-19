//! Room switches use an in-memory router: no sockets, clocks or Redis needed.
use std::sync::Arc;

use gomoku_signaling::config::{Config, ConfigSnapshot};
use gomoku_signaling::metrics::Metrics;
use gomoku_signaling::protocol::ServerMsg;
use gomoku_signaling::relay::RelayManager;
use gomoku_signaling::rooms::{outbound_channel, ConnHandle, PeerId, RoomCode, RoomTable};
use gomoku_signaling::transport::{ConnCtx, ConnDeps, ConnectionRegistry, Router, SeatRegistry};
use tokio::sync::{mpsc, Notify};

fn context(id: u64) -> (ConnCtx, mpsc::Receiver<ServerMsg>) {
    let peer = PeerId::new(&format!("peer{id:04}")).unwrap();
    let (tx, rx) = outbound_channel(32);
    let handle = ConnHandle::new(peer.clone(), Arc::from("test"), tx, Arc::new(Notify::new()));
    (ConnCtx::new(id, peer, Arc::from("test"), handle), rx)
}

fn dependencies() -> ConnDeps {
    ConnDeps {
        cfg: Arc::new(ConfigSnapshot::new(Config::default())),
        rooms: Arc::new(RoomTable::default()),
        conns: Arc::new(ConnectionRegistry::new(100, 100)),
        relay: Arc::new(RelayManager::disabled("test")),
        metrics: Arc::new(Metrics::new()),
        seats: Arc::new(SeatRegistry::new(60000)),
        node_id: Arc::from("test"),
    }
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
