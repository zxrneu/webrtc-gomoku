//! End-to-end integration tests (T16).
//!
//! Everything here goes through the real HTTP/WS stack over a loopback socket:
//! a genuine `tokio-tungstenite` handshake on the client side and the
//! production `build_router`/`AppState` on the server side.
//!
//! Coverage:
//! * single-node full flow (create → join → peer-joined → signal × N → leave → peer-left)
//! * the five frozen error strings, verbatim
//! * the three silent branches (bad JSON / non-object / missing `t` / falsy `data`)
//! * re-create leaves the previous room
//! * cross-node handshake over a simulated Redis (`FakeCluster`)
//! * same room code created on two nodes is rejected
//! * HTTP smoke: `/healthz`, `/config`, `/metrics`, static hosting

mod support;

use std::sync::Arc;

use serde_json::json;

use gomoku_signaling::config::Config;
use gomoku_signaling::relay::Relay;
use gomoku_signaling::rooms::{
    is_valid_peer_id, outbound_channel, ConnHandle, PeerId, RoomCode, RoomTable,
};

use support::client::{TestServer, WsClient, SILENCE_WINDOW};
use support::fake_relay::{FakeCluster, FakeRelay};

/// Build a two-node cluster sharing one simulated Redis.
async fn two_node_cluster() -> (TestServer, TestServer, Arc<FakeCluster>) {
    let cluster = FakeCluster::new();

    let rooms_a = Arc::new(RoomTable::default());
    let relay_a: Arc<dyn Relay> = FakeRelay::new("node-a", cluster.clone(), rooms_a.clone());
    let node_a = TestServer::start_with(Config::default(), relay_a, rooms_a, "node-a").await;

    let rooms_b = Arc::new(RoomTable::default());
    let relay_b: Arc<dyn Relay> = FakeRelay::new("node-b", cluster.clone(), rooms_b.clone());
    let node_b = TestServer::start_with(Config::default(), relay_b, rooms_b, "node-b").await;

    (node_a, node_b, cluster)
}

#[tokio::test]
async fn single_node_full_flow() {
    let server = TestServer::start(Config::default()).await;

    // A creates a room (lower-case code must be uppercased).
    let mut a = WsClient::connect(&server.ws_url()).await;
    a.send_json(json!({"t": "create", "room": "ab12"})).await;
    let created = a.recv_json().await;
    assert_eq!(created["t"], "created");
    assert_eq!(created["room"], "AB12");
    let a_peer = created["peerId"].as_str().expect("peerId").to_string();
    assert!(is_valid_peer_id(&a_peer));

    // B joins the same room with a display name.
    let mut b = WsClient::connect(&server.ws_url()).await;
    b.send_json(json!({"t": "join", "room": "ab12", "name": "小明"}))
        .await;
    let joined = b.recv_json().await;
    assert_eq!(joined["t"], "joined");
    assert_eq!(joined["room"], "AB12");
    let b_peer = joined["peerId"].as_str().expect("peerId").to_string();
    assert_ne!(a_peer, b_peer);

    // A is notified that B joined.
    let peer_joined = a.recv_json().await;
    assert_eq!(peer_joined["t"], "peer-joined");
    assert_eq!(peer_joined["peerId"], b_peer);
    assert_eq!(peer_joined["name"], "小明");

    // B → A signaling (offer).
    b.send_json(json!({"t": "signal", "data": {"kind": "offer", "sdp": "v=0"}}))
        .await;
    let offer = a.recv_json().await;
    assert_eq!(offer["t"], "signal");
    assert_eq!(offer["data"]["kind"], "offer");
    assert_eq!(offer["data"]["sdp"], "v=0");

    // A → B signaling (answer), proving the reverse path.
    a.send_json(json!({"t": "signal", "data": {"kind": "answer"}}))
        .await;
    let answer = b.recv_json().await;
    assert_eq!(answer["t"], "signal");
    assert_eq!(answer["data"]["kind"], "answer");

    // B leaves → A receives peer-left, and the room survives (A is still in it).
    b.send_json(json!({"t": "leave"})).await;
    let peer_left = a.recv_json().await;
    assert_eq!(peer_left["t"], "peer-left");
    assert_eq!(server.state.rooms.len(), 1);
}

#[tokio::test]
async fn the_five_error_texts_are_emitted_verbatim() {
    let server = TestServer::start(Config::default()).await;

    // 1) create with a malformed room code.
    let mut c = WsClient::connect(&server.ws_url()).await;
    c.send_json(json!({"t": "create", "room": "ZZ"})).await;
    assert_eq!(c.recv_json().await["message"], "房间号需为 4 位字母或数字");

    // Establish a real room for the "exists" and "full" cases.
    c.send_json(json!({"t": "create", "room": "AB12"})).await;
    assert_eq!(c.recv_json().await["t"], "created");

    // 2) create an already-existing room (from another connection).
    let mut d = WsClient::connect(&server.ws_url()).await;
    d.send_json(json!({"t": "create", "room": "AB12"})).await;
    assert_eq!(d.recv_json().await["message"], "房间 AB12 已存在，请更换");

    // 3) join a room that does not exist (valid 4-char code).
    let mut e = WsClient::connect(&server.ws_url()).await;
    e.send_json(json!({"t": "join", "room": "NOPE", "name": "x"}))
        .await;
    assert_eq!(e.recv_json().await["message"], "房间 NOPE 不存在");

    // 3b) join with an invalid code is also "not found" (uppercased display).
    let mut e2 = WsClient::connect(&server.ws_url()).await;
    e2.send_json(json!({"t": "join", "room": "zz", "name": "x"}))
        .await;
    assert_eq!(e2.recv_json().await["message"], "房间 ZZ 不存在");

    // 4) join a room that already holds two peers.
    let mut f = WsClient::connect(&server.ws_url()).await;
    f.send_json(json!({"t": "join", "room": "AB12", "name": "f"}))
        .await;
    assert_eq!(f.recv_json().await["t"], "joined");
    // `c` learns about `f` joining.
    assert_eq!(c.recv_json().await["t"], "peer-joined");

    let mut g = WsClient::connect(&server.ws_url()).await;
    g.send_json(json!({"t": "join", "room": "AB12", "name": "g"}))
        .await;
    assert_eq!(g.recv_json().await["message"], "房间已满（仅支持 1v1）");

    // 5) an unknown string `t`.
    let mut h = WsClient::connect(&server.ws_url()).await;
    h.send_json(json!({"t": "bogus"})).await;
    assert_eq!(h.recv_json().await["message"], "未知消息类型");
}

#[tokio::test]
async fn silent_branches_produce_no_response_but_keep_the_socket_alive() {
    let server = TestServer::start(Config::default()).await;
    let mut c = WsClient::connect(&server.ws_url()).await;

    // Bad JSON.
    c.send_raw("{not json").await;
    assert!(c.recv_timeout(SILENCE_WINDOW).await.is_none());

    // Non-object JSON.
    c.send_raw("[1,2,3]").await;
    assert!(c.recv_timeout(SILENCE_WINDOW).await.is_none());

    // Missing `t`.
    c.send_raw(r#"{"room":"AB12"}"#).await;
    assert!(c.recv_timeout(SILENCE_WINDOW).await.is_none());

    // `t` is not a string.
    c.send_raw(r#"{"t":123}"#).await;
    assert!(c.recv_timeout(SILENCE_WINDOW).await.is_none());

    // `signal` with falsy `data`.
    c.send_raw(r#"{"t":"signal","data":null}"#).await;
    assert!(c.recv_timeout(SILENCE_WINDOW).await.is_none());

    // `signal` while not in any room is silently dropped too.
    c.send_raw(r#"{"t":"signal","data":{"kind":"offer"}}"#)
        .await;
    assert!(c.recv_timeout(SILENCE_WINDOW).await.is_none());

    // The connection is still healthy: a valid create works.
    c.send_json(json!({"t": "create", "room": "WXYZ"})).await;
    assert_eq!(c.recv_json().await["t"], "created");
}

#[tokio::test]
async fn re_create_leaves_the_previous_room() {
    let server = TestServer::start(Config::default()).await;

    let mut a = WsClient::connect(&server.ws_url()).await;
    a.send_json(json!({"t": "create", "room": "AAAA"})).await;
    assert_eq!(a.recv_json().await["t"], "created");

    let mut b = WsClient::connect(&server.ws_url()).await;
    b.send_json(json!({"t": "join", "room": "AAAA", "name": "b"}))
        .await;
    assert_eq!(b.recv_json().await["t"], "joined");
    assert_eq!(a.recv_json().await["t"], "peer-joined");

    // A creates a brand-new room: it must first leave AAAA, so B gets peer-left.
    a.send_json(json!({"t": "create", "room": "BBBB"})).await;
    let created = a.recv_json().await;
    assert_eq!(created["t"], "created");
    assert_eq!(created["room"], "BBBB");

    let left = b.recv_json().await;
    assert_eq!(left["t"], "peer-left");
    // Two rooms exist: AAAA (B only) and BBBB (A only).
    assert_eq!(server.state.rooms.len(), 2);
}

#[tokio::test]
async fn cross_node_handshake_signal_and_leave() {
    let (node_a, node_b, cluster) = two_node_cluster().await;

    let mut a = WsClient::connect(&node_a.ws_url()).await;
    a.send_json(json!({"t": "create", "room": "AB12"})).await;
    let created = a.recv_json().await;
    assert_eq!(created["t"], "created");
    assert!(is_valid_peer_id(
        created["peerId"].as_str().expect("peerId")
    ));

    let mut b = WsClient::connect(&node_b.ws_url()).await;
    b.send_json(json!({"t": "join", "room": "AB12", "name": "小明"}))
        .await;
    let joined = b.recv_json().await;
    assert_eq!(joined["t"], "joined");
    let b_peer = joined["peerId"].as_str().expect("peerId").to_string();

    // The room was created on node-a; node-b's join is registered globally.
    assert_eq!(cluster.room_count(), 1);

    // A (on node-a) is notified of B's join through the simulated Redis bus.
    let peer_joined = a.recv_json().await;
    assert_eq!(peer_joined["t"], "peer-joined");
    assert_eq!(peer_joined["peerId"], b_peer);
    assert_eq!(peer_joined["name"], "小明");

    // A → B signaling across nodes.
    a.send_json(json!({"t": "signal", "data": {"kind": "offer"}}))
        .await;
    let offer = b.recv_json().await;
    assert_eq!(offer["t"], "signal");
    assert_eq!(offer["data"]["kind"], "offer");

    // B → A signaling across nodes (reverse path).
    b.send_json(json!({"t": "signal", "data": {"kind": "answer"}}))
        .await;
    let answer = a.recv_json().await;
    assert_eq!(answer["t"], "signal");
    assert_eq!(answer["data"]["kind"], "answer");

    // B leaves; A is notified across nodes.
    b.send_json(json!({"t": "leave"})).await;
    let peer_left = a.recv_json().await;
    assert_eq!(peer_left["t"], "peer-left");

    // The global room survives while A is still a member.
    assert_eq!(cluster.room_count(), 1);
    assert_eq!(node_a.state.rooms.len(), 1);
}

#[tokio::test]
async fn cross_node_duplicate_create_is_rejected() {
    let (node_a, node_b, _cluster) = two_node_cluster().await;

    let mut a = WsClient::connect(&node_a.ws_url()).await;
    a.send_json(json!({"t": "create", "room": "AB12"})).await;
    assert_eq!(a.recv_json().await["t"], "created");

    // node-b must see the global room and reject a duplicate create.
    let mut b = WsClient::connect(&node_b.ws_url()).await;
    b.send_json(json!({"t": "create", "room": "AB12"})).await;
    assert_eq!(b.recv_json().await["message"], "房间 AB12 已存在，请更换");
}

/// F5: on the cross-node join path the room channel must be subscribed
/// *before* `peer-joined` is published — otherwise the remote node can miss
/// the very first packet (subscribe-after-publish race).
#[tokio::test]
async fn join_subscribes_before_publishing_to_the_channel() {
    let cluster = FakeCluster::new();

    let rooms_a = Arc::new(RoomTable::default());
    let relay_a = FakeRelay::new("node-a", cluster.clone(), rooms_a.clone());
    let node_a =
        TestServer::start_with(Config::default(), relay_a.clone(), rooms_a, "node-a").await;

    let rooms_b = Arc::new(RoomTable::default());
    let relay_b = FakeRelay::new("node-b", cluster.clone(), rooms_b.clone());
    let node_b =
        TestServer::start_with(Config::default(), relay_b.clone(), rooms_b, "node-b").await;

    let mut a = WsClient::connect(&node_a.ws_url()).await;
    a.send_json(json!({"t": "create", "room": "AB12"})).await;
    assert_eq!(a.recv_json().await["t"], "created");

    let mut b = WsClient::connect(&node_b.ws_url()).await;
    b.send_json(json!({"t": "join", "room": "AB12", "name": "小明"}))
        .await;
    assert_eq!(b.recv_json().await["t"], "joined");

    let log = relay_b.call_log();
    let subscribe_at = log
        .iter()
        .position(|c| c == "subscribe:AB12")
        .expect("join 必须订阅房间频道");
    let publish_at = log
        .iter()
        .position(|c| c.starts_with("publish:AB12"))
        .expect("跨节点 join 必须发布 peer-joined");
    assert!(
        subscribe_at < publish_at,
        "必须先订阅后发布，避免首包竞态；调用顺序: {log:?}"
    );
}

/// F6: when the Redis `SADD` (registry create) succeeded but the *local*
/// admission failed, the Redis membership must be rolled back — otherwise a
/// stale member keeps the room code permanently occupied (`create` always
/// reports "exists" until the TTL lapses).
#[tokio::test]
async fn failed_local_create_rolls_back_the_redis_membership() {
    let cluster = FakeCluster::new();
    let rooms = Arc::new(RoomTable::default());
    let relay = FakeRelay::new("node-a", cluster.clone(), rooms.clone());
    let server =
        TestServer::start_with(Config::default(), relay.clone(), rooms.clone(), "node-a").await;

    // 本地已存在同名房间（绕过 registry 直插），Redis 中还没有该房间：
    // 此时 registry_create 的 SADD 会成功，但本地 create 必然 Exists。
    let (tx, _rx) = outbound_channel(4);
    rooms
        .create(
            RoomCode::new("AB12").expect("code"),
            ConnHandle::new(
                PeerId::new("aaaaaaaa").expect("peer"),
                Arc::from("node-a"),
                tx,
                Arc::new(tokio::sync::Notify::new()),
            ),
        )
        .expect("create");
    assert_eq!(cluster.room_count(), 0);

    let mut c = WsClient::connect(&server.ws_url()).await;
    c.send_json(json!({"t": "create", "room": "AB12"})).await;
    assert_eq!(c.recv_json().await["message"], "房间 AB12 已存在，请更换");

    assert_eq!(
        cluster.room_count(),
        0,
        "本地创建失败后必须回滚 Redis SADD，不得残留陈旧成员"
    );
}

/// F6: same rollback on the join path — the Redis `SADD` succeeded but the
/// local room was already full (registry/local divergence), so the member
/// must be removed from the Redis set again.
#[tokio::test]
async fn failed_local_join_rolls_back_the_redis_membership() {
    let cluster = FakeCluster::new();

    let rooms_a = Arc::new(RoomTable::default());
    let relay_a = FakeRelay::new("node-a", cluster.clone(), rooms_a.clone());
    let node_a =
        TestServer::start_with(Config::default(), relay_a.clone(), rooms_a, "node-a").await;

    let rooms_b = Arc::new(RoomTable::default());
    let relay_b = FakeRelay::new("node-b", cluster.clone(), rooms_b.clone());
    let node_b = TestServer::start_with(
        Config::default(),
        relay_b.clone(),
        rooms_b.clone(),
        "node-b",
    )
    .await;

    // a 在 node-a 建房；b1 在 node-b 加入。
    let mut a = WsClient::connect(&node_a.ws_url()).await;
    a.send_json(json!({"t": "create", "room": "AB12"})).await;
    let a_peer = a.recv_json().await["peerId"]
        .as_str()
        .expect("peerId")
        .to_string();

    let mut b1 = WsClient::connect(&node_b.ws_url()).await;
    b1.send_json(json!({"t": "join", "room": "AB12", "name": "b1"}))
        .await;
    assert_eq!(b1.recv_json().await["t"], "joined");

    // 制造注册表与本地表的背离：Redis 成员集只剩 1 人（a 的陈旧残留被清掉），
    // 而 node-b 本地房间已有 2 人——正是 F6 要防御的「SADD 后本地 Full」场景。
    cluster.force_remove_member("AB12", &format!("node-a:{a_peer}"));
    let code = RoomCode::new("AB12").expect("code");
    let (tx, _rx) = outbound_channel(4);
    rooms_b
        .join(
            &code,
            ConnHandle::new(
                PeerId::new("bbbbbbbb").expect("peer"),
                Arc::from("node-b"),
                tx,
                Arc::new(tokio::sync::Notify::new()),
            ),
        )
        .expect("local join");
    assert_eq!(rooms_b.len_of(&code), 2);
    assert_eq!(cluster.member_count("AB12"), 1);

    // b3 加入：registry_join 看到 Redis 只有 1 人 → SADD 成功；本地房间已满 → Full。
    let mut b3 = WsClient::connect(&node_b.ws_url()).await;
    b3.send_json(json!({"t": "join", "room": "AB12", "name": "b3"}))
        .await;
    assert_eq!(b3.recv_json().await["message"], "房间已满（仅支持 1v1）");

    assert_eq!(
        cluster.member_count("AB12"),
        1,
        "本地 join 失败后必须回滚 Redis SADD（b3 不得残留）"
    );
}

#[tokio::test]
async fn http_smoke_health_config_and_metrics() {
    let server = TestServer::start(Config::default()).await;
    let client = reqwest::Client::new();

    // /healthz — v1-compatible shape.
    let resp = client
        .get(server.http_url("/healthz"))
        .send()
        .await
        .expect("healthz");
    assert_eq!(resp.status(), 200);
    let health: serde_json::Value = resp.json().await.expect("health json");
    assert_eq!(health["ok"], true);
    assert_eq!(health["rooms"], 0);
    assert!(health["uptime"].is_number());

    // /config — STUN-only (no TURN configured) with no-cache.
    let resp = client
        .get(server.http_url("/config"))
        .send()
        .await
        .expect("config");
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-cache")
    );
    let cfg: serde_json::Value = resp.json().await.expect("config json");
    let servers = cfg["iceServers"].as_array().expect("iceServers array");
    assert_eq!(servers.len(), 1, "only the STUN entry should be present");
    assert!(servers[0]["urls"].is_array());

    // /metrics — Prometheus text with the gomoku_ prefix.
    let text = client
        .get(server.http_url("/metrics"))
        .send()
        .await
        .expect("metrics")
        .text()
        .await
        .expect("metrics text");
    assert!(text.contains("gomoku_ws_connections"));
    assert!(text.contains("gomoku_rooms"));
}

#[tokio::test]
async fn static_hosting_serves_index_and_404s_missing_assets() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("index.html"), "<html>root</html>").expect("index");
    std::fs::write(dir.path().join("app.js"), "console.log(1)").expect("app.js");

    let mut cfg = Config::default();
    cfg.server.public_dir = dir.path().to_string_lossy().to_string();
    let server = TestServer::start(cfg).await;
    let client = reqwest::Client::new();

    // Root → index.html.
    let resp = client.get(server.http_url("/")).send().await.expect("root");
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.text().await.expect("body"), "<html>root</html>");

    // SPA fallback for an extension-less route.
    let resp = client
        .get(server.http_url("/some/spa/route"))
        .send()
        .await
        .expect("spa");
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.text().await.expect("body"), "<html>root</html>");

    // A missing asset (has an extension) is a hard 404.
    let resp = client
        .get(server.http_url("/missing.js"))
        .send()
        .await
        .expect("missing");
    assert_eq!(resp.status(), 404);
}
