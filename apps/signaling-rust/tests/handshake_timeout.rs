//! Regression test for the WS handshake timeout (P2-2).
//!
//! A client that opens the TCP connection but never sends a request must be
//! closed within `timeouts.ws_handshake_timeout_secs` — this is enforced at the
//! connection level by `http::serve` (hyper `header_read_timeout`). The default
//! value is 10s, so configuring 1s and observing a close well under the default
//! proves the setting genuinely takes effect.

mod support;

use std::time::{Duration, Instant};

use gomoku_signaling::config::Config;
use support::client::TestServer;
use tokio::io::AsyncReadExt;

#[tokio::test]
async fn silent_tcp_connection_is_closed_within_handshake_timeout() {
    let mut cfg = Config::default();
    cfg.timeouts.ws_handshake_timeout_secs = 1;
    let server = TestServer::start(cfg).await;

    let mut stream = tokio::net::TcpStream::connect(server.addr)
        .await
        .expect("connect");
    let start = Instant::now();

    // The client deliberately sends nothing (no HTTP request, no WS upgrade).
    let mut buf = [0u8; 64];
    let outcome = tokio::time::timeout(Duration::from_secs(4), stream.read(&mut buf)).await;
    let elapsed = start.elapsed();

    match outcome {
        // Graceful close (EOF) or reset — either means the server hung up.
        Ok(Ok(0)) | Ok(Err(_)) => {}
        Ok(Ok(n)) => panic!("expected the connection to be closed, got {n} bytes"),
        Err(_) => panic!("connection stayed open for >4s (handshake timeout not enforced)"),
    }
    assert!(
        elapsed < Duration::from_millis(2500),
        "connection closed after {elapsed:?}, expected ~1s (ws_handshake_timeout_secs=1)"
    );
}

#[tokio::test]
async fn a_well_formed_ws_client_still_connects() {
    // The connection-level timeout must not break the happy path.
    let mut cfg = Config::default();
    cfg.timeouts.ws_handshake_timeout_secs = 1;
    let server = TestServer::start(cfg).await;

    let mut client = support::client::WsClient::connect(&server.ws_url()).await;
    client
        .send_json(serde_json::json!({"t": "create", "room": "AB12"}))
        .await;
    assert_eq!(client.recv_json().await["t"], "created");
}
