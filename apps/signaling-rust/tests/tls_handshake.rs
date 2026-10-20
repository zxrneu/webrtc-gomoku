//! Real TLS + HTTP/WebSocket integration without modifying any system trust store.
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use gomoku_signaling::config::env::MapEnv;
use gomoku_signaling::config::{Config, ConfigSnapshot};
use gomoku_signaling::http::router::build_router;
use gomoku_signaling::http::server::{serve_with_tls, ServerTransport};
use gomoku_signaling::http::tls::load_tls_config;
use gomoku_signaling::http::AppState;
use gomoku_signaling::metrics::Metrics;
use gomoku_signaling::relay::RelayManager;
use gomoku_signaling::rooms::RoomTable;
use gomoku_signaling::transport::registry::ConnectionRegistry;
use gomoku_signaling::transport::seat::SeatRegistry;
use gomoku_signaling::transport::shutdown::Shutdown;
use tokio::io::AsyncReadExt;
use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer, ServerName};
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::Message;

fn openssl(root: &Path, args: &[&str]) {
    let output = Command::new("openssl")
        .args(args)
        .current_dir(root)
        .output()
        .expect("openssl installed");
    assert!(
        output.status.success(),
        "openssl: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn certificates() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    openssl(
        temp.path(),
        &[
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-keyout",
            "ca-key.pem",
            "-out",
            "ca.pem",
            "-subj",
            "/CN=gomoku-test-ca",
        ],
    );
    openssl(
        temp.path(),
        &[
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "key.pem",
            "-out",
            "request.csr",
            "-subj",
            "/CN=localhost",
        ],
    );
    std::fs::write(temp.path().join("extensions.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n").unwrap();
    openssl(
        temp.path(),
        &[
            "x509",
            "-req",
            "-in",
            "request.csr",
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca-key.pem",
            "-CAcreateserial",
            "-out",
            "cert.pem",
            "-days",
            "1",
            "-extfile",
            "extensions.cnf",
        ],
    );
    temp
}

async fn server(temp: &Path) -> (std::net::SocketAddr, AppState, tokio::task::JoinHandle<()>) {
    let env = MapEnv::new(&[("TLS_CERT_FILE", "cert.pem"), ("TLS_KEY_FILE", "key.pem")]);
    let tls = load_tls_config(&env, temp).unwrap();
    let state = AppState {
        cfg: Arc::new(ConfigSnapshot::new(Config::default())),
        lobby: Arc::new(tokio::sync::Mutex::new(Default::default())),
        rooms: Arc::new(RoomTable::default()),
        conns: Arc::new(ConnectionRegistry::new(100, 10)),
        relay: Arc::new(RelayManager::disabled("tls-test")),
        metrics: Arc::new(Metrics::new()),
        shutdown: Shutdown::new(),
        seats: Arc::new(SeatRegistry::default()),
        node_id: Arc::from("tls-test"),
        started: Instant::now(),
        public_dir: temp.to_path_buf(),
        log_level: None,
    };
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap();
    let mut shutdown = state.shutdown.subscribe();
    let handle = tokio::spawn(serve_with_tls(
        ServerTransport {
            tcp,
            tls,
            handshake_timeout: Duration::from_secs(1),
        },
        build_router(state.clone()),
        async move {
            let _ = shutdown.wait_for(|value| *value).await;
        },
    ));
    (addr, state, handle)
}

fn connector(temp: &Path) -> TlsConnector {
    let root = CertificateDer::from_pem_file(temp.join("ca.pem")).unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(root).unwrap();
    let provider = tokio_rustls::rustls::crypto::ring::default_provider();
    let cfg = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(cfg))
}

#[tokio::test]
async fn trusted_https_and_wss_share_the_same_listener_and_shutdown_cleanly() {
    let temp = certificates();
    std::fs::write(temp.path().join("index.html"), "tls-static-page").unwrap();
    let (addr, state, handle) = server(temp.path()).await;
    let ca = reqwest::Certificate::from_pem(&std::fs::read(temp.path().join("ca.pem")).unwrap())
        .unwrap();
    let client = reqwest::Client::builder()
        .add_root_certificate(ca)
        .build()
        .unwrap();
    let base = format!("https://{addr}");
    assert!(
        reqwest::get(format!("{base}/healthz")).await.is_err(),
        "untrusted CA must be rejected"
    );
    assert_eq!(
        client
            .get(&base)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "tls-static-page"
    );
    let health: serde_json::Value = client
        .get(format!("{base}/healthz"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["ok"], true);
    let config: serde_json::Value = client
        .get(format!("{base}/config"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(config["capabilities"]["lobby"], true);
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let stream = connector(temp.path())
        .connect(ServerName::try_from("localhost").unwrap(), tcp)
        .await
        .unwrap();
    let (mut ws, _) = tokio_tungstenite::client_async(format!("wss://{addr}/signal"), stream)
        .await
        .unwrap();
    ws.send(Message::Text(r#"{"t":"ping","ts":42}"#.into()))
        .await
        .unwrap();
    let pong: serde_json::Value = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Message::Text(text) = ws.next().await.unwrap().unwrap() {
                break serde_json::from_str(&text).unwrap();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(pong["t"], "pong");
    assert_eq!(pong["ts"].as_f64(), Some(42.0));
    state.shutdown.trigger();
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if ws.next().await.unwrap().unwrap().is_close() {
                break;
            }
        }
    })
    .await
    .expect("shutdown must close the TLS WebSocket");
}

#[tokio::test]
async fn silent_tls_handshake_is_bounded_by_existing_handshake_timeout() {
    let temp = certificates();
    let (addr, state, handle) = server(temp.path()).await;
    let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut byte = [0u8];
    let outcome = tokio::time::timeout(Duration::from_millis(2500), tcp.read(&mut byte)).await;
    assert!(
        matches!(outcome, Ok(Ok(0)) | Ok(Err(_))),
        "silent TLS socket must close"
    );
    state.shutdown.trigger();
    handle.await.unwrap();
}

#[tokio::test]
async fn shutdown_cancels_an_unfinished_tls_handshake() {
    let temp = certificates();
    let (addr, state, handle) = server(temp.path()).await;
    let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    // Give the accept loop a chance to take ownership of this socket.
    tokio::task::yield_now().await;
    state.shutdown.trigger();
    tokio::time::timeout(Duration::from_millis(500), handle)
        .await
        .unwrap()
        .unwrap();
    let mut byte = [0u8];
    let outcome = tokio::time::timeout(Duration::from_millis(500), tcp.read(&mut byte)).await;
    assert!(
        matches!(outcome, Ok(Ok(0)) | Ok(Err(_))),
        "shutdown must close pending TLS handshakes"
    );
}

#[test]
fn certificate_with_another_private_key_is_rejected_before_serving() {
    let temp = certificates();
    std::fs::copy(temp.path().join("ca-key.pem"), temp.path().join("key.pem")).unwrap();
    let env = MapEnv::new(&[("TLS_CERT_FILE", "cert.pem"), ("TLS_KEY_FILE", "key.pem")]);
    let error = load_tls_config(&env, temp.path()).unwrap_err().to_string();
    assert!(error.contains("TLS_CERT_FILE"));
    assert!(error.contains("TLS_KEY_FILE"));
}

#[test]
fn invalid_private_key_is_rejected_without_leaking_its_contents() {
    let temp = certificates();
    std::fs::write(temp.path().join("key.pem"), "PRIVATE_SENTINEL").unwrap();
    let env = MapEnv::new(&[("TLS_CERT_FILE", "cert.pem"), ("TLS_KEY_FILE", "key.pem")]);
    let error = load_tls_config(&env, temp.path()).unwrap_err().to_string();
    assert!(error.contains("TLS_KEY_FILE"));
    assert!(!error.contains("PRIVATE_SENTINEL"));
}
