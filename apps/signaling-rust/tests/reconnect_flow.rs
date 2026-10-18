//! Integration tests for disconnect & reconnect (v1.1 protocol).
//!
//! Covers:
//! * ping -> pong
//! * token issued in created / joined
//! * drop connection -> peer receives peer-offline with graceSec
//! * signal to offline peer silently dropped
//! * resume -> resumed with rotated token
//! * peer receives peer-online
//! * bidirectional signaling resumes after reconnect
//! * token rotation allows subsequent resume
//! * resume with invalid token -> RESUME_TOKEN_INVALID
//! * resume with unknown room -> RESUME_REJECTED
//! * explicit leave releases seat -> subsequent resume rejected
//! * cross-node peer-offline and peer-online relay

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use gomoku_signaling::config::Config;
use gomoku_signaling::relay::Relay;
use gomoku_signaling::rooms::RoomTable;

use support::client::{TestServer, WsClient, SILENCE_WINDOW};
use support::fake_relay::{FakeCluster, FakeRelay};

#[tokio::test]
async fn ping_produces_pong() {
    let server = TestServer::start(Config::default()).await;
    let mut client = WsClient::connect(&server.ws_url()).await;

    client.send_json(json!({"t": "ping"})).await;
    let resp = client.recv_json().await;
    assert_eq!(resp, json!({"t": "pong"}));

    // ping with ts also works
    client
        .send_json(json!({"t": "ping", "ts": 123456789.0}))
        .await;
    let resp = client.recv_json().await;
    assert_eq!(resp, json!({"t": "pong", "ts": 123456789.0}));
}

#[tokio::test]
async fn created_and_joined_contain_seat_tokens() {
    let server = TestServer::start(Config::default()).await;

    let mut a = WsClient::connect(&server.ws_url()).await;
    a.send_json(json!({"t": "create", "room": "RC01"})).await;
    let created = a.recv_json().await;
    assert_eq!(created["t"], "created");
    assert_eq!(created["room"], "RC01");
    let token_a = created["token"].as_str().expect("host token");
    assert_eq!(token_a.len(), 32);

    let mut b = WsClient::connect(&server.ws_url()).await;
    b.send_json(json!({"t": "join", "room": "RC01"})).await;
    let joined = b.recv_json().await;
    assert_eq!(joined["t"], "joined");
    assert_eq!(joined["room"], "RC01");
    let token_b = joined["token"].as_str().expect("guest token");
    assert_eq!(token_b.len(), 32);
    assert_ne!(token_a, token_b);
}

#[tokio::test]
async fn host_disconnect_and_resume_flow() {
    let server = TestServer::start(Config::default()).await;

    // 1. Host creates room
    let mut host = WsClient::connect(&server.ws_url()).await;
    host.send_json(json!({"t": "create", "room": "RC02"})).await;
    let created = host.recv_json().await;
    let host_peer = created["peerId"].as_str().unwrap().to_string();
    let host_token = created["token"].as_str().unwrap().to_string();

    // 2. Guest joins room
    let mut guest = WsClient::connect(&server.ws_url()).await;
    guest
        .send_json(json!({"t": "join", "room": "RC02", "name": "Guest"}))
        .await;
    let joined = guest.recv_json().await;
    let guest_peer = joined["peerId"].as_str().unwrap().to_string();

    // Host receives peer-joined
    let peer_joined = host.recv_json().await;
    assert_eq!(peer_joined["t"], "peer-joined");
    assert_eq!(peer_joined["peerId"], guest_peer);

    // 3. Host disconnects abruptly
    drop(host);

    // Guest receives peer-offline
    let offline = guest.recv_json().await;
    assert_eq!(offline["t"], "peer-offline");
    assert_eq!(offline["graceSec"], 60);

    // 4. Guest sends signal while host is offline -> silently dropped
    guest
        .send_json(json!({"t": "signal", "data": {"cand": "x"}}))
        .await;
    assert!(guest.recv_timeout(SILENCE_WINDOW).await.is_none());

    // 5. Host reconnects via a new socket and sends resume
    let mut host_new = WsClient::connect(&server.ws_url()).await;
    host_new
        .send_json(json!({
            "t": "resume",
            "room": "RC02",
            "peerId": host_peer,
            "token": host_token
        }))
        .await;

    // Host receives resumed with rotated token
    let resumed = host_new.recv_json().await;
    assert_eq!(resumed["t"], "resumed");
    assert_eq!(resumed["room"], "RC02");
    assert_eq!(resumed["peerId"], host_peer);
    assert_eq!(resumed["peerPresent"], true);
    let new_token = resumed["token"].as_str().unwrap().to_string();
    assert_eq!(new_token.len(), 32);
    assert_ne!(new_token, host_token);

    // Guest receives peer-online
    let online = guest.recv_json().await;
    assert_eq!(online["t"], "peer-online");

    // 6. Test bidirectional signaling after resume
    host_new
        .send_json(json!({"t": "signal", "data": {"type": "offer", "sdp": "host-sdp"}}))
        .await;
    let sig_for_guest = guest.recv_json().await;
    assert_eq!(sig_for_guest["t"], "signal");
    assert_eq!(sig_for_guest["data"]["sdp"], "host-sdp");

    guest
        .send_json(json!({"t": "signal", "data": {"type": "answer", "sdp": "guest-sdp"}}))
        .await;
    let sig_for_host = host_new.recv_json().await;
    assert_eq!(sig_for_host["t"], "signal");
    assert_eq!(sig_for_host["data"]["sdp"], "guest-sdp");
}

#[tokio::test]
async fn guest_disconnect_and_resume_flow() {
    let server = TestServer::start(Config::default()).await;

    let mut host = WsClient::connect(&server.ws_url()).await;
    host.send_json(json!({"t": "create", "room": "RC03"})).await;
    let created = host.recv_json().await;
    let _host_peer = created["peerId"].as_str().unwrap().to_string();

    let mut guest = WsClient::connect(&server.ws_url()).await;
    guest.send_json(json!({"t": "join", "room": "RC03"})).await;
    let joined = guest.recv_json().await;
    let guest_peer = joined["peerId"].as_str().unwrap().to_string();
    let guest_token = joined["token"].as_str().unwrap().to_string();

    let _ = host.recv_json().await; // peer-joined

    // Guest drops
    drop(guest);

    // Host receives peer-offline
    let offline = host.recv_json().await;
    assert_eq!(offline["t"], "peer-offline");
    assert_eq!(offline["graceSec"], 60);

    // Guest resumes
    let mut guest_new = WsClient::connect(&server.ws_url()).await;
    guest_new
        .send_json(json!({
            "t": "resume",
            "room": "RC03",
            "peerId": guest_peer,
            "token": guest_token
        }))
        .await;

    let resumed = guest_new.recv_json().await;
    assert_eq!(resumed["t"], "resumed");
    assert_eq!(resumed["room"], "RC03");
    assert_eq!(resumed["peerId"], guest_peer);
    assert_eq!(resumed["peerPresent"], true);

    // Host receives peer-online
    let online = host.recv_json().await;
    assert_eq!(online["t"], "peer-online");

    // Signaling works
    guest_new
        .send_json(json!({"t": "signal", "data": "hello host"}))
        .await;
    let sig = host.recv_json().await;
    assert_eq!(sig["t"], "signal");
    assert_eq!(sig["data"], "hello host");
}

#[tokio::test]
async fn multiple_consecutive_resumes_with_rotated_tokens() {
    let server = TestServer::start(Config::default()).await;

    let mut host = WsClient::connect(&server.ws_url()).await;
    host.send_json(json!({"t": "create", "room": "RC04"})).await;
    let created = host.recv_json().await;
    let host_peer = created["peerId"].as_str().unwrap().to_string();
    let token1 = created["token"].as_str().unwrap().to_string();

    // First drop and resume
    drop(host);
    let mut host2 = WsClient::connect(&server.ws_url()).await;
    host2
        .send_json(json!({
            "t": "resume",
            "room": "RC04",
            "peerId": host_peer,
            "token": token1
        }))
        .await;
    let resumed1 = host2.recv_json().await;
    assert_eq!(resumed1["t"], "resumed");
    let token2 = resumed1["token"].as_str().unwrap().to_string();
    assert_ne!(token2, token1);

    // Verify old token is rejected
    let mut imposter = WsClient::connect(&server.ws_url()).await;
    imposter
        .send_json(json!({
            "t": "resume",
            "room": "RC04",
            "peerId": host_peer,
            "token": token1
        }))
        .await;
    let err = imposter.recv_json().await;
    assert_eq!(err["t"], "error");
    assert_eq!(err["code"], "RESUME_TOKEN_INVALID");

    // Second drop and resume with token2
    drop(host2);
    let mut host3 = WsClient::connect(&server.ws_url()).await;
    host3
        .send_json(json!({
            "t": "resume",
            "room": "RC04",
            "peerId": host_peer,
            "token": token2
        }))
        .await;
    let resumed2 = host3.recv_json().await;
    assert_eq!(resumed2["t"], "resumed");
    assert_eq!(resumed2["peerId"], host_peer);
}

#[tokio::test]
async fn resume_error_paths() {
    let server = TestServer::start(Config::default()).await;

    // 1. Resume unknown room
    let mut c1 = WsClient::connect(&server.ws_url()).await;
    c1.send_json(json!({
        "t": "resume",
        "room": "NOPE",
        "peerId": "aaaa1234",
        "token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }))
    .await;
    let err1 = c1.recv_json().await;
    assert_eq!(err1["t"], "error");
    assert_eq!(err1["code"], "RESUME_REJECTED");
    assert_eq!(err1["message"], "房间已失效，请重新加入");

    // 2. Create room and test invalid token
    let mut host = WsClient::connect(&server.ws_url()).await;
    host.send_json(json!({"t": "create", "room": "RC05"})).await;
    let created = host.recv_json().await;
    let host_peer = created["peerId"].as_str().unwrap();

    let mut c2 = WsClient::connect(&server.ws_url()).await;
    c2.send_json(json!({
        "t": "resume",
        "room": "RC05",
        "peerId": host_peer,
        "token": "wrong-token-wrong-token-wrong-to"
    }))
    .await;
    let err2 = c2.recv_json().await;
    assert_eq!(err2["t"], "error");
    assert_eq!(err2["code"], "RESUME_TOKEN_INVALID");
    assert_eq!(err2["message"], "座位凭证无效");

    // 3. Host explicitly leaves -> seat is released -> resume rejected
    host.send_json(json!({"t": "leave"})).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut c3 = WsClient::connect(&server.ws_url()).await;
    c3.send_json(json!({
        "t": "resume",
        "room": "RC05",
        "peerId": host_peer,
        "token": "wrong-token-wrong-token-wrong-to"
    }))
    .await;
    let err3 = c3.recv_json().await;
    assert_eq!(err3["t"], "error");
    assert_eq!(err3["code"], "RESUME_REJECTED");
}

#[tokio::test]
async fn cross_node_offline_and_online_relaying() {
    let cluster = FakeCluster::new();

    let rooms_a = Arc::new(RoomTable::default());
    let relay_a: Arc<dyn Relay> = FakeRelay::new("node-a", cluster.clone(), rooms_a.clone());
    let node_a = TestServer::start_with(Config::default(), relay_a, rooms_a, "node-a").await;

    let rooms_b = Arc::new(RoomTable::default());
    let relay_b: Arc<dyn Relay> = FakeRelay::new("node-b", cluster.clone(), rooms_b.clone());
    let node_b = TestServer::start_with(Config::default(), relay_b, rooms_b, "node-b").await;

    // Node A: Host creates room
    let mut host = WsClient::connect(&node_a.ws_url()).await;
    host.send_json(json!({"t": "create", "room": "XN01"})).await;
    let created = host.recv_json().await;
    let host_peer = created["peerId"].as_str().unwrap().to_string();
    let host_token = created["token"].as_str().unwrap().to_string();

    // Node B: Guest joins room
    let mut guest = WsClient::connect(&node_b.ws_url()).await;
    guest.send_json(json!({"t": "join", "room": "XN01"})).await;
    let joined = guest.recv_json().await;
    let guest_peer = joined["peerId"].as_str().unwrap().to_string();

    let peer_joined = host.recv_json().await;
    assert_eq!(peer_joined["t"], "peer-joined");
    assert_eq!(peer_joined["peerId"], guest_peer);

    // Host on node A drops
    drop(host);

    // Guest on node B receives peer-offline via cross-node relay!
    let offline = guest.recv_json().await;
    assert_eq!(offline["t"], "peer-offline");
    assert_eq!(offline["graceSec"], 60);

    // Host reconnects on node A (resuming local seat)
    let mut host_new = WsClient::connect(&node_a.ws_url()).await;
    host_new
        .send_json(json!({
            "t": "resume",
            "room": "XN01",
            "peerId": host_peer,
            "token": host_token
        }))
        .await;
    let resumed = host_new.recv_json().await;
    assert_eq!(resumed["t"], "resumed");

    // Guest on node B receives peer-online via cross-node relay!
    let online = guest.recv_json().await;
    assert_eq!(online["t"], "peer-online");

    // Cross-node signaling works after resume!
    host_new
        .send_json(json!({"t": "signal", "data": "cross-node-sdp"}))
        .await;
    let sig = guest.recv_json().await;
    assert_eq!(sig["t"], "signal");
    assert_eq!(sig["data"], "cross-node-sdp");
}

#[tokio::test]
async fn concurrent_resume_race_condition() {
    let server = TestServer::start(Config::default()).await;
    let mut host = WsClient::connect(&server.ws_url()).await;
    host.send_json(json!({"t": "create", "room": "RC10"})).await;
    let created = host.recv_json().await;
    let peer_id = created["peerId"].as_str().unwrap().to_string();
    let token = created["token"].as_str().unwrap().to_string();
    drop(host);

    // Two clients connect concurrently and attempt resume with the exact same token
    let mut c1 = WsClient::connect(&server.ws_url()).await;
    let mut c2 = WsClient::connect(&server.ws_url()).await;

    let payload = json!({
        "t": "resume",
        "room": "RC10",
        "peerId": peer_id,
        "token": token,
    });

    // Send simultaneously
    tokio::join!(c1.send_json(payload.clone()), c2.send_json(payload.clone()));

    let (r1, r2) = tokio::join!(c1.recv_json(), c2.recv_json());

    // Exactly one must succeed with "resumed", the other must fail with RESUME_TOKEN_INVALID
    let successes = [&r1, &r2].iter().filter(|r| r["t"] == "resumed").count();
    let invalids = [&r1, &r2]
        .iter()
        .filter(|r| r["t"] == "error" && r["code"] == "RESUME_TOKEN_INVALID")
        .count();

    assert_eq!(
        successes, 1,
        "exactly one client should successfully resume"
    );
    assert_eq!(
        invalids, 1,
        "the other client should be rejected with RESUME_TOKEN_INVALID"
    );
}

#[tokio::test]
async fn cross_node_resume_switches_node() {
    let cluster = FakeCluster::new();

    let rooms_a = Arc::new(RoomTable::default());
    let relay_a: Arc<dyn Relay> = FakeRelay::new("node-a", cluster.clone(), rooms_a.clone());
    let node_a = TestServer::start_with(Config::default(), relay_a, rooms_a, "node-a").await;

    let rooms_b = Arc::new(RoomTable::default());
    let relay_b: Arc<dyn Relay> = FakeRelay::new("node-b", cluster.clone(), rooms_b.clone());
    let node_b = TestServer::start_with(Config::default(), relay_b, rooms_b, "node-b").await;

    // Node A: Host creates room
    let mut host = WsClient::connect(&node_a.ws_url()).await;
    host.send_json(json!({"t": "create", "room": "XN02"})).await;
    let created = host.recv_json().await;
    let host_peer = created["peerId"].as_str().unwrap().to_string();
    let host_token = created["token"].as_str().unwrap().to_string();

    // Node A: Guest joins room
    let mut guest = WsClient::connect(&node_a.ws_url()).await;
    guest.send_json(json!({"t": "join", "room": "XN02"})).await;
    let joined = guest.recv_json().await;
    let _guest_peer = joined["peerId"].as_str().unwrap().to_string();
    let _ = host.recv_json().await; // peer-joined

    // Host drops connection on Node A
    drop(host);
    let offline = guest.recv_json().await;
    assert_eq!(offline["t"], "peer-offline");

    // Host reconnects to Node B (different node!)
    let mut host_b = WsClient::connect(&node_b.ws_url()).await;
    host_b
        .send_json(json!({
            "t": "resume",
            "room": "XN02",
            "peerId": host_peer,
            "token": host_token
        }))
        .await;
    let resumed = host_b.recv_json().await;
    assert_eq!(resumed["t"], "resumed");
    assert_eq!(resumed["peerPresent"], true);

    // Guest on Node A receives peer-online
    let online = guest.recv_json().await;
    assert_eq!(online["t"], "peer-online");

    // Bidirectional signaling between Host (on Node B) and Guest (on Node A)
    host_b
        .send_json(json!({"t": "signal", "data": "from-host-on-node-b"}))
        .await;
    let sig = guest.recv_json().await;
    assert_eq!(sig["t"], "signal");
    assert_eq!(sig["data"], "from-host-on-node-b");

    guest
        .send_json(json!({"t": "signal", "data": "from-guest-on-node-a"}))
        .await;
    let sig2 = host_b.recv_json().await;
    assert_eq!(sig2["t"], "signal");
    assert_eq!(sig2["data"], "from-guest-on-node-a");
}

#[tokio::test]
async fn peer_present_reflects_cross_node_members() {
    let cluster = FakeCluster::new();

    let rooms_a = Arc::new(RoomTable::default());
    let relay_a: Arc<dyn Relay> = FakeRelay::new("node-a", cluster.clone(), rooms_a.clone());
    let node_a = TestServer::start_with(Config::default(), relay_a, rooms_a, "node-a").await;

    let rooms_b = Arc::new(RoomTable::default());
    let relay_b: Arc<dyn Relay> = FakeRelay::new("node-b", cluster.clone(), rooms_b.clone());
    let node_b = TestServer::start_with(Config::default(), relay_b, rooms_b, "node-b").await;

    // Node A: Host creates room
    let mut host = WsClient::connect(&node_a.ws_url()).await;
    host.send_json(json!({"t": "create", "room": "XN03"})).await;
    let created = host.recv_json().await;
    let host_peer = created["peerId"].as_str().unwrap().to_string();
    let host_token = created["token"].as_str().unwrap().to_string();

    // Node B: Guest joins room
    let mut guest = WsClient::connect(&node_b.ws_url()).await;
    guest.send_json(json!({"t": "join", "room": "XN03"})).await;
    let _ = guest.recv_json().await; // joined
    let _ = host.recv_json().await; // peer-joined

    // Host drops and reconnects to Node A -> Guest is on Node B (cross-node opponent), peerPresent must be true!
    drop(host);
    let _ = guest.recv_json().await; // peer-offline

    let mut host2 = WsClient::connect(&node_a.ws_url()).await;
    host2
        .send_json(json!({
            "t": "resume",
            "room": "XN03",
            "peerId": host_peer,
            "token": host_token
        }))
        .await;
    let resumed = host2.recv_json().await;
    assert_eq!(resumed["t"], "resumed");
    assert_eq!(resumed["peerPresent"], true);
    let host_token2 = resumed["token"].as_str().unwrap().to_string();
    let _ = guest.recv_json().await; // peer-online

    // Now Guest on Node B explicitly leaves
    guest.send_json(json!({"t": "leave"})).await;
    let _ = host2.recv_json().await; // peer-left

    // Host drops and reconnects again -> opponent left, peerPresent must be false!
    drop(host2);
    let mut host3 = WsClient::connect(&node_a.ws_url()).await;
    host3
        .send_json(json!({
            "t": "resume",
            "room": "XN03",
            "peerId": host_peer,
            "token": host_token2
        }))
        .await;
    let resumed3 = host3.recv_json().await;
    assert_eq!(resumed3["t"], "resumed");
    assert_eq!(resumed3["peerPresent"], false);
}

#[tokio::test]
async fn superseded_connection_cannot_destroy_seat_or_send_signals() {
    let server = TestServer::start(Config::default()).await;

    // 1. Host creates room on C1
    let mut c1 = WsClient::connect(&server.ws_url()).await;
    c1.send_json(json!({"t": "create", "room": "RC20"})).await;
    let created = c1.recv_json().await;
    let peer_id = created["peerId"].as_str().unwrap().to_string();
    let token = created["token"].as_str().unwrap().to_string();

    // 2. Guest connects on C_G
    let mut cg = WsClient::connect(&server.ws_url()).await;
    cg.send_json(json!({"t": "join", "room": "RC20"})).await;
    let _ = cg.recv_json().await; // joined
    let _ = c1.recv_json().await; // peer-joined

    // 3. C2 connects and resumes Host seat while C1 is still connected
    let mut c2 = WsClient::connect(&server.ws_url()).await;
    c2.send_json(json!({
        "t": "resume",
        "room": "RC20",
        "peerId": peer_id,
        "token": token
    }))
    .await;
    let resumed = c2.recv_json().await;
    assert_eq!(resumed["t"], "resumed");

    // Guest receives peer-online when C2 resumes
    let online = cg.recv_json().await;
    assert_eq!(online["t"], "peer-online");

    // 4. Old connection C1 attempts to send leave -> must NOT destroy seat or notify guest
    c1.send_json(json!({"t": "leave"})).await;

    // Guest should NOT receive peer-left!
    assert!(cg.recv_timeout(SILENCE_WINDOW).await.is_none());

    // 5. Old connection C1 attempts to send signal -> must be ignored
    c1.send_json(json!({"t": "signal", "data": "stale-signal"}))
        .await;
    assert!(cg.recv_timeout(SILENCE_WINDOW).await.is_none());

    // 6. Active connection C2 can send signal successfully
    c2.send_json(json!({"t": "signal", "data": "active-signal"}))
        .await;
    let sig = cg.recv_json().await;
    assert_eq!(sig["t"], "signal");
    assert_eq!(sig["data"], "active-signal");
}

#[tokio::test]
async fn resume_rejected_if_already_in_room() {
    let server = TestServer::start(Config::default()).await;

    // Client connects and creates room R1
    let mut client = WsClient::connect(&server.ws_url()).await;
    client
        .send_json(json!({"t": "create", "room": "RC30"}))
        .await;
    let created = client.recv_json().await;
    assert_eq!(created["t"], "created");

    // Client tries to resume into another room while already in RC30
    client
        .send_json(json!({
            "t": "resume",
            "room": "RC31",
            "peerId": "dummy123",
            "token": "dummy-token-dummy-token-dummy-t"
        }))
        .await;

    let err = client.recv_json().await;
    assert_eq!(err["t"], "error");
    assert_eq!(err["code"], "RESUME_REJECTED");
    assert_eq!(err["message"], "房间已失效，请重新加入");

    // Client's original room RC30 is intact: opponent can still join
    let mut guest = WsClient::connect(&server.ws_url()).await;
    guest.send_json(json!({"t": "join", "room": "RC30"})).await;
    let joined = guest.recv_json().await;
    assert_eq!(joined["t"], "joined");

    let peer_joined = client.recv_json().await;
    assert_eq!(peer_joined["t"], "peer-joined");
}
