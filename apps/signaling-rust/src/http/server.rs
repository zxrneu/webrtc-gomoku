//! Connection-serving loop that enforces the WebSocket handshake timeout.
//!
//! `axum::serve` starts the router only *after* hyper has parsed the request
//! head, so a client that opens a TCP connection and sends nothing (or a
//! partial request) would otherwise linger forever — the router's
//! `TimeoutLayer` never fires for it.
//!
//! We drive hyper's HTTP/1 connection directly and set `header_read_timeout`,
//! which closes such a connection after `timeouts.ws_handshake_timeout_secs`.
//! The same builder still performs the WS upgrade (`with_upgrades`), and we
//! inject `ConnectInfo` so per-IP admission keeps working exactly as before.

use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::Router;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tower::Service;

/// Serve `app` on `listener` until `shutdown` resolves.
///
/// `handshake_timeout` bounds how long a client may take to transmit its
/// request head; because it is enforced at the connection level it also covers
/// clients that never complete a WebSocket upgrade.
pub async fn serve<F>(listener: TcpListener, app: Router, handshake_timeout: Duration, shutdown: F)
where
    F: Future<Output = ()>,
{
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(pair) => pair,
                    Err(_) => continue,
                };
                let app = app.clone();
                tokio::spawn(serve_connection(stream, peer, app, handshake_timeout));
            }
        }
    }
}

/// Drive a single connection to completion.
async fn serve_connection(
    stream: tokio::net::TcpStream,
    peer: SocketAddr,
    app: Router,
    handshake_timeout: Duration,
) {
    let io = TokioIo::new(stream);
    let service = service_fn(move |req: hyper::Request<Incoming>| {
        let mut app = app.clone();
        async move {
            let (mut parts, body) = req.into_parts();
            // The `/signal` handler extracts `ConnectInfo` for per-IP limiting.
            parts.extensions.insert(ConnectInfo(peer));
            let req = axum::http::Request::from_parts(parts, Body::new(body));
            app.call(req).await
        }
    });

    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .header_read_timeout(handshake_timeout)
        .timer(TokioTimer::new());
    let _ = builder.serve_connection(io, service).with_upgrades().await;
}
