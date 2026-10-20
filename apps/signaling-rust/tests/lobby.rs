//! Lobby behavior through the real router, with bounded in-memory connections.
use gomoku_signaling::config::{Config, ConfigSnapshot};
use gomoku_signaling::metrics::Metrics;
use gomoku_signaling::protocol::ServerMsg;
use gomoku_signaling::relay::RelayManager;
use gomoku_signaling::rooms::{outbound_channel, ConnHandle, PeerId, RoomCode, RoomTable};
use gomoku_signaling::transport::{
    ConnCtx, ConnDeps, ConnectionRegistry, Router, SeatRegistry, VerifyResult,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};

fn deps() -> ConnDeps {
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
fn person(id: u64) -> (ConnCtx, mpsc::Receiver<ServerMsg>) {
    let peer = PeerId::new(&format!("peer{id:04}")).unwrap();
    let (tx, rx) = outbound_channel(256);
    let handle = ConnHandle::new(peer.clone(), Arc::from("test"), tx, Arc::new(Notify::new()));
    (ConnCtx::new(id, peer, Arc::from("test"), handle), rx)
}
async fn send(r: &Router, c: &ConnCtx, v: Value) {
    r.handle(c, &v.to_string()).await;
}
async fn enter(r: &Router, c: &ConnCtx, name: &str) {
    send(r,c,json!({"t":"lobby-enter","name":name,"browserId":format!("browser{}",c.conn_id),"tabId":format!("tab{}",c.conn_id)})).await;
}
fn frames(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<Value> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .map(|v| serde_json::from_str(&v.encode()).unwrap())
        .collect()
}
fn last(rx: &mut mpsc::Receiver<ServerMsg>, t: &str) -> Value {
    frames(rx)
        .into_iter()
        .rfind(|v| v["t"] == t)
        .unwrap_or(Value::Null)
}
async fn state(r: &Router, c: &ConnCtx, rx: &mut mpsc::Receiver<ServerMsg>) -> Value {
    send(r, c, json!({"t":"lobby-list"})).await;
    last(rx, "lobby-state")
}

#[tokio::test]
async fn departed_host_leaves_a_public_room_owned_by_the_promoted_guest() {
    let d = deps();
    let r = Router::new(d.clone());
    let (host, mut host_rx) = person(1);
    let (guest, mut guest_rx) = person(2);
    let (next, mut next_rx) = person(3);
    enter(&r, &host, "松间").await;
    enter(&r, &guest, "听雨").await;
    enter(&r, &next, "新客").await;
    send(&r, &host, json!({"t":"lobby-create","public":true})).await;
    let code = last(&mut host_rx, "lobby-seat")["room"].clone();
    send(&r, &guest, json!({"t":"lobby-join","room":code})).await;
    frames(&mut guest_rx);

    send(&r, &host, json!({"t":"leave"})).await;

    let promoted = state(&r, &guest, &mut guest_rx).await;
    assert_eq!(promoted["room"]["role"], "host");
    assert_eq!(promoted["rooms"][0]["name"], "听雨");
    assert_eq!(promoted["room"]["public"], true);
    send(&r, &next, json!({"t":"lobby-join","room":code})).await;
    assert_eq!(last(&mut next_rx, "lobby-seat")["role"], "guest");
}

#[tokio::test]
async fn presence_names_are_unique_and_do_not_expose_seat_credentials() {
    let d = deps();
    let r = Router::new(d);
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "棋友").await;
    enter(&r, &b, "棋友").await;
    let s = state(&r, &a, &mut ra).await;
    assert_eq!(s["online"], 2);
    assert_eq!(s["users"].as_array().unwrap().len(), 2);
    assert_eq!(state(&r, &b, &mut rb).await["name"], "棋友2");
    assert!(!s.to_string().contains("token"));
    assert_ne!(s["selfId"], a.peer_id().as_str());
}
#[tokio::test]
async fn malformed_input_is_rejected_without_entering() {
    let r = Router::new(deps());
    let (a, mut rx) = person(1);
    enter(&r, &a, "<script>").await;
    assert_eq!(last(&mut rx, "lobby-notice")["code"], "INVALID_INPUT");
    send(&r, &a, json!({"t":"lobby-list"})).await;
    assert_eq!(last(&mut rx, "lobby-notice")["code"], "NOT_ENTERED");
}
#[tokio::test]
async fn search_filters_and_paginates_twenty_users() {
    let r = Router::new(deps());
    let (a, mut rx) = person(1);
    enter(&r, &a, "自己").await;
    let mut keep = Vec::new();
    for n in 2..26 {
        let (c, rc) = person(n);
        enter(&r, &c, &format!("棋友{n}")).await;
        keep.push((c, rc));
    }
    let s = state(&r, &a, &mut rx).await;
    assert_eq!(s["users"].as_array().unwrap().len(), 20);
    assert_eq!(s["totalUsers"], 25);
    send(&r, &a, json!({"t":"lobby-list","offset":20})).await;
    assert_eq!(
        last(&mut rx, "lobby-state")["users"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    send(&r, &a, json!({"t":"lobby-list","query":"棋友25"})).await;
    assert_eq!(last(&mut rx, "lobby-state")["totalUsers"], 1);
}
#[tokio::test]
async fn invitation_accepts_once_and_issues_resumable_seats() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    let target = state(&r, &b, &mut rb).await["selfId"].clone();
    send(&r, &a, json!({"t":"lobby-invite","target":target})).await;
    assert_eq!(d.rooms.len(), 0);
    let i = state(&r, &b, &mut rb).await["invite"].clone();
    assert!(i.is_object());
    send(
        &r,
        &b,
        json!({"t":"lobby-respond","id":i["id"],"accept":true}),
    )
    .await;
    let sa = last(&mut ra, "lobby-seat");
    let sb = last(&mut rb, "lobby-seat");
    assert_eq!(sa["room"], sb["room"]);
    assert_eq!(sa["role"], "host");
    assert_eq!(sb["role"], "guest");
    let room = RoomCode::new(sa["room"].as_str().unwrap()).unwrap();
    assert_eq!(d.rooms.len_of(&room), 2);
    assert_eq!(
        d.seats
            .verify(&a.peer_id(), &room, sa["token"].as_str().unwrap(), 0),
        VerifyResult::Ok
    );
    send(
        &r,
        &b,
        json!({"t":"lobby-respond","id":i["id"],"accept":true}),
    )
    .await;
    assert_eq!(d.rooms.len(), 1);
}
#[tokio::test]
async fn declined_invitation_cools_down_and_cannot_create_a_room() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    let t = state(&r, &b, &mut rb).await["selfId"].clone();
    send(&r, &a, json!({"t":"lobby-invite","target":t})).await;
    let i = state(&r, &b, &mut rb).await["invite"]["id"].clone();
    send(&r, &b, json!({"t":"lobby-respond","id":i,"accept":false})).await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "DECLINED");
    send(&r, &a, json!({"t":"lobby-invite","target":t})).await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "RATE_LIMITED");
    assert_eq!(d.rooms.len(), 0);
}
#[tokio::test]
async fn canceled_invitation_and_wrong_recipient_cannot_be_accepted() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    let t = state(&r, &b, &mut rb).await["selfId"].clone();
    send(&r, &a, json!({"t":"lobby-invite","target":t})).await;
    let i = state(&r, &b, &mut rb).await["invite"]["id"].clone();
    send(&r, &a, json!({"t":"lobby-respond","id":i,"accept":true})).await;
    assert_eq!(d.rooms.len(), 0);
    send(&r, &a, json!({"t":"lobby-cancel","id":i})).await;
    send(&r, &b, json!({"t":"lobby-respond","id":i,"accept":true})).await;
    assert_eq!(d.rooms.len(), 0);
    assert!(state(&r, &a, &mut ra).await["invite"].is_null());
}
#[tokio::test]
async fn quick_match_cancel_is_idempotent_and_matching_uses_one_private_room() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    send(&r, &a, json!({"t":"lobby-match","action":"join"})).await;
    send(&r, &a, json!({"t":"lobby-match","action":"join"})).await;
    assert!(state(&r, &a, &mut ra).await["match"].is_object());
    send(&r, &a, json!({"t":"lobby-match","action":"leave"})).await;
    send(&r, &b, json!({"t":"lobby-match","action":"join"})).await;
    assert_eq!(d.rooms.len(), 0);
    send(&r, &a, json!({"t":"lobby-match","action":"join"})).await;
    assert_eq!(d.rooms.len(), 1);
    assert_eq!(last(&mut rb, "lobby-seat")["role"], "host");
    assert_eq!(state(&r, &a, &mut ra).await["rooms"], json!([]));
}
#[tokio::test]
async fn public_room_can_be_joined_and_host_controls_visibility() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    let (c, mut rc) = person(3);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    enter(&r, &c, "竹影").await;
    send(&r, &a, json!({"t":"lobby-create","public":true})).await;
    let seat = last(&mut ra, "lobby-seat");
    let code = seat["room"].clone();
    assert_eq!(state(&r, &b, &mut rb).await["rooms"][0]["code"], code);
    send(&r, &b, json!({"t":"lobby-join","room":code})).await;
    assert_eq!(last(&mut rb, "lobby-seat")["role"], "guest");
    send(&r, &c, json!({"t":"lobby-join","room":code})).await;
    assert_eq!(last(&mut rc, "lobby-notice")["code"], "ROOM_FULL");
    send(&r, &b, json!({"t":"lobby-visibility","public":false})).await;
    assert_eq!(state(&r, &c, &mut rc).await["totalRooms"], 1);
    send(&r, &a, json!({"t":"lobby-visibility","public":false})).await;
    assert_eq!(state(&r, &c, &mut rc).await["totalRooms"], 0);
}
#[tokio::test]
async fn leave_releases_lobby_room_and_busy_manual_session_cannot_match() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    enter(&r, &a, "松间").await;
    send(&r, &a, json!({"t":"lobby-create","public":true})).await;
    send(&r, &a, json!({"t":"leave"})).await;
    assert_eq!(d.rooms.len(), 0);
    assert!(state(&r, &a, &mut ra).await["room"].is_null());
    send(&r, &a, json!({"t":"lobby-ready","ready":true})).await;
    send(&r, &a, json!({"t":"lobby-match","action":"join"})).await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "BUSY");
}

fn timed_deps() -> (ConnDeps, Arc<std::sync::atomic::AtomicU64>) {
    use std::sync::atomic::{AtomicU64, Ordering};
    let mut d = deps();
    let time = Arc::new(AtomicU64::new(1000));
    let clock = time.clone();
    d.lobby = Arc::new(tokio::sync::Mutex::new(
        gomoku_signaling::transport::lobby::Lobby::with_sources(
            Arc::new(move || clock.load(Ordering::SeqCst)),
            Arc::new(gomoku_signaling::transport::seat::new_token),
        ),
    ));
    (d, time)
}
#[tokio::test]
async fn invitation_expires_at_thirty_seconds_and_rejects_late_acceptance() {
    let (d, time) = timed_deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    let t = state(&r, &b, &mut rb).await["selfId"].clone();
    send(&r, &a, json!({"t":"lobby-invite","target":t})).await;
    let id = state(&r, &b, &mut rb).await["invite"]["id"].clone();
    time.store(31000, std::sync::atomic::Ordering::SeqCst);
    send(&r, &b, json!({"t":"lobby-respond","id":id,"accept":true})).await;
    assert_eq!(d.rooms.len(), 0);
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "EXPIRED");
    send(&r, &a, json!({"t":"lobby-invite","target":t})).await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "RATE_LIMITED");
    time.store(91000, std::sync::atomic::Ordering::SeqCst);
    send(&r, &a, json!({"t":"lobby-invite","target":t})).await;
    assert!(state(&r, &b, &mut rb).await["invite"].is_object());
}
#[tokio::test]
async fn matching_expires_at_sixty_seconds_without_allocating_a_seat() {
    let (d, time) = timed_deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    enter(&r, &a, "松间").await;
    send(&r, &a, json!({"t":"lobby-match","action":"join"})).await;
    time.store(61000, std::sync::atomic::Ordering::SeqCst);
    let s = state(&r, &a, &mut ra).await;
    assert!(s["match"].is_null());
    assert_eq!(d.rooms.len(), 0);
}
#[tokio::test]
async fn disconnected_idle_user_disappears_and_cancels_their_invitation() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    let t = state(&r, &b, &mut rb).await["selfId"].clone();
    send(&r, &a, json!({"t":"lobby-invite","target":t})).await;
    gomoku_signaling::transport::connection::on_disconnect(&d, &b).await;
    let s = state(&r, &a, &mut ra).await;
    assert_eq!(s["online"], 1);
    assert!(s["invite"].is_null());
}
#[tokio::test]
async fn resume_rebinds_presence_and_stale_close_cannot_remove_the_restored_user() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    enter(&r, &a, "松间").await;
    send(&r, &a, json!({"t":"lobby-create","public":true})).await;
    let seat = last(&mut ra, "lobby-seat");
    let (b, mut rb) = person(2);
    enter(&r, &b, "听雨").await;
    send(
        &r,
        &b,
        json!({"t":"resume","room":seat["room"],"peerId":seat["peerId"],"token":seat["token"]}),
    )
    .await;
    assert_eq!(b.peer_id(), a.peer_id());
    assert_eq!(last(&mut rb, "resumed")["room"], seat["room"]);
    gomoku_signaling::transport::connection::on_disconnect(&d, &a).await;
    let s = state(&r, &b, &mut rb).await;
    assert_eq!(s["online"], 1);
    assert_eq!(s["room"]["role"], "host");
    assert!(d
        .seats
        .peek(&b.peer_id())
        .unwrap()
        .offline_since_ms
        .is_none());
}
#[tokio::test]
async fn one_browser_allows_two_tabs_and_refresh_takes_over_the_same_tab() {
    let r = Router::new(deps());
    let (a, _ra) = person(1);
    let (b, _rb) = person(2);
    let (c, mut rc) = person(3);
    for (ctx, tab) in [(&a, "a"), (&b, "b")] {
        send(
            &r,
            ctx,
            json!({"t":"lobby-enter","name":"棋友","browserId":"browser","tabId":tab}),
        )
        .await;
    }
    send(
        &r,
        &c,
        json!({"t":"lobby-enter","name":"棋友","browserId":"browser","tabId":"c"}),
    )
    .await;
    assert_eq!(last(&mut rc, "lobby-notice")["code"], "SESSION_LIMIT");
    send(
        &r,
        &c,
        json!({"t":"lobby-enter","name":"棋友","browserId":"browser","tabId":"a"}),
    )
    .await;
    assert_eq!(state(&r, &c, &mut rc).await["online"], 2);
}
#[tokio::test]
async fn failed_room_join_is_rate_limited_and_never_changes_existing_room() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    enter(&r, &a, "松间").await;
    send(&r, &a, json!({"t":"lobby-join","room":"AAAA"})).await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "ROOM_NOT_FOUND");
    send(&r, &a, json!({"t":"lobby-create","public":true})).await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "RATE_LIMITED");
    assert_eq!(d.rooms.len(), 0);
}
#[tokio::test]
async fn manual_ready_interrupts_pending_invitation() {
    let r = Router::new(deps());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    let t = state(&r, &b, &mut rb).await["selfId"].clone();
    send(&r, &a, json!({"t":"lobby-invite","target":t})).await;
    send(&r, &b, json!({"t":"lobby-ready","ready":true})).await;
    assert!(state(&r, &a, &mut ra).await["invite"].is_null());
}
#[tokio::test]
async fn flood_of_lobby_mutations_is_bounded() {
    let r = Router::new(deps());
    let (a, mut ra) = person(1);
    enter(&r, &a, "松间").await;
    for _ in 0..45 {
        send(&r, &a, json!({"t":"lobby-name","name":"松间"})).await;
    }
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "RATE_LIMITED");
}

struct RejectJoin;
#[async_trait::async_trait]
impl gomoku_signaling::relay::Relay for RejectJoin {
    async fn publish(
        &self,
        _: gomoku_signaling::relay::CrossNodeMsg,
    ) -> Result<(), gomoku_signaling::relay::RelayError> {
        Ok(())
    }
    async fn subscribe_room(&self, _: &RoomCode) {}
    async fn unsubscribe_room(&self, _: &RoomCode) {}
    async fn registry_create(
        &self,
        _: &RoomCode,
        _: &str,
        _: u64,
    ) -> Result<bool, gomoku_signaling::relay::RelayError> {
        Ok(true)
    }
    async fn registry_join(
        &self,
        _: &RoomCode,
        _: &str,
        _: u64,
    ) -> Result<gomoku_signaling::relay::JoinStatus, gomoku_signaling::relay::RelayError> {
        Ok(gomoku_signaling::relay::JoinStatus::Full)
    }
    async fn registry_leave(
        &self,
        _: &RoomCode,
        _: &str,
    ) -> Result<gomoku_signaling::relay::LeaveStatus, gomoku_signaling::relay::RelayError> {
        Ok(gomoku_signaling::relay::LeaveStatus::RoomDeleted)
    }
    fn is_connected(&self) -> bool {
        false
    }
}
#[tokio::test]
async fn failed_pair_admission_does_not_publish_a_half_created_seat() {
    let mut d = deps();
    d.relay = Arc::new(RejectJoin);
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    frames(&mut ra);
    frames(&mut rb);
    send(&r, &a, json!({"t":"lobby-match","action":"join"})).await;
    send(&r, &b, json!({"t":"lobby-match","action":"join"})).await;
    assert!(last(&mut ra, "lobby-seat").is_null());
    assert!(last(&mut rb, "lobby-seat").is_null());
    assert_eq!(d.rooms.len(), 0);
    assert_eq!(d.seats.len(), 0);
}

#[tokio::test]
async fn lobby_room_capacity_is_bounded_without_lowering_legacy_server_capacity() {
    let d = deps();
    let r = Router::new(d.clone());
    let (filler, _) = person(99);
    for n in 0..1000 {
        d.rooms
            .create(RoomCode::new(&format!("{n:04X}")).unwrap(), filler.handle())
            .unwrap();
    }
    let (a, mut ra) = person(1);
    enter(&r, &a, "松间").await;
    send(&r, &a, json!({"t":"lobby-create","public":true})).await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "LIMIT");
    assert_eq!(d.rooms.len(), 1000);
    assert!(a.current_room().is_none());
}

#[tokio::test]
async fn combining_alphabetic_marks_are_rejected_on_enter_and_rename() {
    let r = Router::new(deps());
    let (a, mut ra) = person(1);
    // U+0345 is Alphabetic but General_Category=Mn, so TS \p{L}\p{N} rejects it.
    enter(&r, &a, "棋\u{0345}").await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "INVALID_INPUT");
    enter(&r, &a, "棋友").await;
    send(&r, &a, json!({"t":"lobby-name","name":"棋\u{0345}"})).await;
    assert_eq!(last(&mut ra, "lobby-notice")["code"], "INVALID_INPUT");
    assert_eq!(state(&r, &a, &mut ra).await["name"], "棋友");
}

#[tokio::test]
async fn unicode_letter_and_number_categories_remain_valid_names() {
    let r = Router::new(deps());
    let (a, mut ra) = person(1);
    enter(&r, &a, "棋友").await;
    // CJK letters, full-width Nd, Roman Nl, superscript No, Arabic Nd, astral Lu.
    for name in ["棋友", "棋１２", "棋Ⅻ", "棋²", "棋١٢", "𐐀棋"] {
        send(&r, &a, json!({"t":"lobby-name","name":name})).await;
        assert_eq!(state(&r, &a, &mut ra).await["name"], name);
    }
}

#[tokio::test]
async fn flush_uses_one_shared_publication_time_and_retains_individual_filters() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let mut d = deps();
    let reads = Arc::new(AtomicU64::new(1));
    let clock = reads.clone();
    d.lobby = Arc::new(tokio::sync::Mutex::new(
        gomoku_signaling::transport::lobby::Lobby::with_sources(
            Arc::new(move || clock.fetch_add(1, Ordering::SeqCst)),
            Arc::new(gomoku_signaling::transport::seat::new_token),
        ),
    ));
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    send(&r, &b, json!({"t":"lobby-list","query":"听雨"})).await;
    frames(&mut ra);
    frames(&mut rb);
    let before = reads.load(Ordering::SeqCst);
    d.lobby.lock().await.flush(&d);
    let sa = last(&mut ra, "lobby-state");
    let sb = last(&mut rb, "lobby-state");
    assert_eq!(sa["serverNow"], sb["serverNow"]);
    // One expiry clock read plus one shared projection clock read per cycle.
    assert_eq!(reads.load(Ordering::SeqCst) - before, 2);
    assert_eq!(sa["totalUsers"], 2);
    assert_eq!(sb["totalUsers"], 1);
    assert_eq!(sb["users"][0]["name"], "听雨");
}

#[tokio::test]
async fn repeated_queries_reuse_the_current_public_projection() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let mut d = deps();
    let reads = Arc::new(AtomicU64::new(1));
    let clock = reads.clone();
    d.lobby = Arc::new(tokio::sync::Mutex::new(
        gomoku_signaling::transport::lobby::Lobby::with_sources(
            Arc::new(move || clock.fetch_add(1, Ordering::SeqCst)),
            Arc::new(gomoku_signaling::transport::seat::new_token),
        ),
    ));
    let r = Router::new(d);
    let (a, mut ra) = person(1);
    enter(&r, &a, "松间").await;
    frames(&mut ra);
    let before = reads.load(Ordering::SeqCst);
    send(&r, &a, json!({"t":"lobby-list","query":"松"})).await;
    let first = last(&mut ra, "lobby-state");
    send(&r, &a, json!({"t":"lobby-list","query":"间"})).await;
    let second = last(&mut ra, "lobby-state");
    assert_eq!(first["serverNow"], second["serverNow"]);
    // Both queries only read expiry and request-rate clocks; neither rebuilds projection.
    assert_eq!(reads.load(Ordering::SeqCst) - before, 4);
    assert_eq!(first["totalUsers"], 1);
    assert_eq!(second["totalUsers"], 1);
}

#[tokio::test]
async fn disconnect_burst_is_published_once_on_the_next_cycle() {
    let d = deps();
    let r = Router::new(d.clone());
    let (observer, mut rx) = person(99);
    enter(&r, &observer, "旁观").await;
    let mut departing = Vec::new();
    for id in 1..=10 {
        let (ctx, receiver) = person(id);
        enter(&r, &ctx, &format!("棋友{id}")).await;
        departing.push((ctx, receiver));
    }
    d.lobby.lock().await.flush(&d);
    frames(&mut rx);
    for (ctx, _) in &departing {
        gomoku_signaling::transport::connection::on_disconnect(&d, ctx).await;
    }
    assert!(
        frames(&mut rx).is_empty(),
        "disconnect must not broadcast to unrelated users"
    );
    d.lobby.lock().await.flush(&d);
    let published = frames(&mut rx);
    assert_eq!(published.len(), 1);
    assert_eq!(published[0]["online"], 1);
}

#[tokio::test]
async fn querying_after_disconnect_returns_current_users_before_publication() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, _ra) = person(1);
    let (b, mut rb) = person(2);
    enter(&r, &a, "松间").await;
    enter(&r, &b, "听雨").await;
    d.lobby.lock().await.flush(&d);
    frames(&mut rb);
    gomoku_signaling::transport::connection::on_disconnect(&d, &a).await;
    let current = state(&r, &b, &mut rb).await;
    assert_eq!(current["online"], 1);
    assert_eq!(current["totalUsers"], 1);
    assert_eq!(current["users"][0]["name"], "听雨");
}

#[tokio::test]
async fn unchanged_lobby_does_not_broadcast_and_queries_do_not_schedule_broadcasts() {
    let d = deps();
    let r = Router::new(d.clone());
    let (a, mut ra) = person(1);
    enter(&r, &a, "松间").await;
    d.lobby.lock().await.flush(&d);
    frames(&mut ra);
    state(&r, &a, &mut ra).await;
    d.lobby.lock().await.flush(&d);
    d.lobby.lock().await.flush(&d);
    assert!(
        frames(&mut ra).is_empty(),
        "unchanged roster must not be broadcast every second"
    );
    send(&r, &a, json!({"t":"lobby-name","name":"新昵称"})).await;
    frames(&mut ra);
    d.lobby.lock().await.flush(&d);
    assert_eq!(last(&mut ra, "lobby-state")["name"], "新昵称");
}

#[tokio::test]
async fn legacy_room_mutations_do_not_broadcast_to_unrelated_users_immediately() {
    let d = deps();
    let r = Router::new(d.clone());
    let (observer, mut rx) = person(1);
    let (host, mut host_rx) = person(2);
    enter(&r, &observer, "旁观").await;
    d.lobby.lock().await.flush(&d);
    frames(&mut rx);
    send(&r, &host, json!({"t":"create","room":"AB12"})).await;
    assert_eq!(last(&mut host_rx, "created")["room"], "AB12");
    assert!(frames(&mut rx).is_empty());
    d.lobby.lock().await.flush(&d);
    assert_eq!(frames(&mut rx).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn expired_guest_seat_updates_a_previously_cached_public_room() {
    let mut d = deps();
    d.seats = Arc::new(SeatRegistry::new(0));
    let r = Router::new(d.clone());
    let (host, mut host_rx) = person(1);
    let (guest, mut guest_rx) = person(2);
    enter(&r, &host, "松间").await;
    enter(&r, &guest, "听雨").await;
    send(&r, &host, json!({"t":"lobby-create","public":true})).await;
    let code = last(&mut host_rx, "lobby-seat")["room"].clone();
    send(&r, &guest, json!({"t":"lobby-join","room":code})).await;
    frames(&mut guest_rx);
    gomoku_signaling::transport::connection::on_disconnect(&d, &guest).await;
    d.lobby.lock().await.flush(&d);
    let before = state(&r, &host, &mut host_rx).await;
    assert_eq!(before["rooms"][0]["count"], 2);

    let (_shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let sweeper = gomoku_signaling::transport::seat::spawn_sweeper(d.clone(), shutdown_rx);
    tokio::task::yield_now().await;
    let interval = d.cfg.snapshot().session.sweep_interval_secs;
    tokio::time::advance(std::time::Duration::from_secs(interval)).await;
    tokio::task::yield_now().await;
    d.lobby.lock().await.flush(&d);
    let after = state(&r, &host, &mut host_rx).await;
    sweeper.abort();
    assert_eq!(after["rooms"][0]["count"], 1);
}
