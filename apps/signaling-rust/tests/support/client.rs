//! A real (TCP + WebSocket) test harness for the signaling server.
//!
//! The server is served on an ephemeral loopback port with
//! `into_make_service_with_connect_info` so the `/signal` handler sees a real
//! peer address (required by per-IP admission). Clients connect with a genuine
//! `tokio-tungstenite` handshake — this is a true end-to-end path, not a mock.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use gomoku_signaling::config::{Config, ConfigSnapshot};
use gomoku_signaling::http::router::build_router;
use gomoku_signaling::http::AppState;
use gomoku_signaling::metrics::Metrics;
use gomoku_signaling::relay::{Relay, RelayManager};
use gomoku_signaling::rooms::RoomTable;
use gomoku_signaling::transport::registry::ConnectionRegistry;
use gomoku_signaling::transport::shutdown::Shutdown;

/// The concrete client socket type.
pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A running server bound to `127.0.0.1:<ephemeral>`.
pub struct TestServer {
    /// Loopback address the server listens on.
    pub addr: SocketAddr,
    /// The shared application state (for assertions such as `rooms.len()`).
    pub state: AppState,
    handle: tokio::task::JoinHandle<()>,
}

impl TestServer {
    /// Start a node with no cross-node relay (single-node / degraded mode).
    pub async fn start(cfg: Config) -> Self {
        let rooms = Arc::new(RoomTable::default());
        let relay: Arc<dyn Relay> = Arc::new(RelayManager::disabled("gomoku:signal"));
        Self::start_with(cfg, relay, rooms, "test-node").await
    }

    /// Start a node with an explicit relay + room table (for cluster tests).
    pub async fn start_with(
        cfg: Config,
        relay: Arc<dyn Relay>,
        rooms: Arc<RoomTable>,
        node_id: &str,
    ) -> Self {
        let public_dir =
            gomoku_signaling::http::static_files::resolve_public_dir(&cfg.server.public_dir);
        let handshake_timeout = Duration::from_secs(cfg.timeouts.ws_handshake_timeout_secs);
        let state = AppState {
            seats: Arc::new(gomoku_signaling::transport::seat::SeatRegistry::new(
                cfg.session.grace_secs.saturating_mul(1000),
            )),
            cfg: Arc::new(ConfigSnapshot::new(cfg)),
            rooms,
            conns: Arc::new(ConnectionRegistry::new(1_000, 100)),
            relay,
            metrics: Arc::new(Metrics::new()),
            shutdown: Shutdown::new(),
            node_id: Arc::from(node_id),
            started: Instant::now(),
            public_dir,
            log_level: None,
        };
        Self::serve(state, handshake_timeout).await
    }

    async fn serve(state: AppState, handshake_timeout: Duration) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let app = build_router(state.clone());
        let handle = tokio::spawn(async move {
            gomoku_signaling::http::serve(
                listener,
                app,
                handshake_timeout,
                std::future::pending::<()>(),
            )
            .await;
        });
        TestServer {
            addr,
            state,
            handle,
        }
    }

    /// `ws://` URL for the `/signal` endpoint.
    pub fn ws_url(&self) -> String {
        format!("ws://{}/signal", self.addr)
    }

    /// `http://` URL for an arbitrary path.
    pub fn http_url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// A thin WebSocket client that speaks the frozen JSON protocol.
pub struct WsClient {
    ws: Ws,
}

impl WsClient {
    /// Connect to `url` and complete the WS handshake.
    pub async fn connect(url: &str) -> Self {
        let (ws, _resp) = connect_async(url).await.expect("ws handshake");
        Self { ws }
    }

    /// Send a JSON value as a text frame.
    pub async fn send_json(&mut self, value: serde_json::Value) {
        self.send_raw(&value.to_string()).await;
    }

    /// Send a raw text frame (used for malformed-JSON tests).
    pub async fn send_raw(&mut self, raw: &str) {
        self.ws
            .send(Message::Text(raw.to_string()))
            .await
            .expect("send frame");
    }

    /// Receive the next JSON text frame, skipping control/binary frames.
    ///
    /// Returns `None` when the socket closes.
    pub async fn recv(&mut self) -> Option<serde_json::Value> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    return Some(serde_json::from_str(text.as_str()).expect("json frame"));
                }
                Some(Ok(Message::Close(_))) | None => return None,
                Some(Ok(_)) => continue, // ping / pong / binary
                Some(Err(_)) => return None,
            }
        }
    }

    /// Receive the next JSON frame, panicking on close.
    pub async fn recv_json(&mut self) -> serde_json::Value {
        self.recv().await.expect("a frame before close")
    }

    /// Wait up to `dur` for a frame; `None` on timeout (used to prove silence).
    pub async fn recv_timeout(&mut self, dur: Duration) -> Option<serde_json::Value> {
        tokio::time::timeout(dur, self.recv()).await.ok().flatten()
    }
}

/// A short window used when asserting that the server stayed silent.
pub const SILENCE_WINDOW: Duration = Duration::from_millis(250);
