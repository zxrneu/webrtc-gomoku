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
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::Router;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::task::JoinSet;
use tokio_rustls::{rustls::ServerConfig, TlsAcceptor};
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
    serve_with_tls(
        ServerTransport {
            tcp: listener,
            tls: None,
            handshake_timeout,
        },
        app,
        shutdown,
    )
    .await;
}

/// Startup transport settings; application routes and socket peer identity are unchanged.
pub struct ServerTransport {
    pub tcp: TcpListener,
    pub tls: Option<Arc<ServerConfig>>,
    pub handshake_timeout: Duration,
}

/// Serve optional TLS and cancel incomplete TLS handshakes when shutdown resolves.
pub async fn serve_with_tls<F>(transport: ServerTransport, app: Router, shutdown: F)
where
    F: Future<Output = ()>,
{
    tokio::pin!(shutdown);
    let mut handshakes = JoinSet::new();
    let acceptor = transport.tls.map(TlsAcceptor::from);
    let timeout = transport.handshake_timeout;
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            completed = handshakes.join_next(), if !handshakes.is_empty() => {
                if let Some(Ok(Some((stream, peer)))) = completed {
                    tokio::spawn(serve_connection(stream, peer, app.clone(), timeout));
                }
            }
            accepted = transport.tcp.accept() => {
                let Ok((stream, peer)) = accepted else { continue; };
                if let Some(acceptor) = acceptor.clone() {
                    handshakes.spawn(async move {
                        accept_tls(stream, acceptor, timeout).await.map(|stream| (stream, peer))
                    });
                } else {
                    tokio::spawn(serve_connection(stream, peer, app.clone(), timeout));
                }
            }
        }
    }
    handshakes.abort_all();
    while handshakes.join_next().await.is_some() {}
}

async fn accept_tls(
    stream: tokio::net::TcpStream,
    acceptor: TlsAcceptor,
    timeout: Duration,
) -> Option<tokio_rustls::server::TlsStream<tokio::net::TcpStream>> {
    tokio::time::timeout(timeout, acceptor.accept(stream))
        .await
        .ok()?
        .ok()
}

/// Drive a single connection to completion.
async fn serve_connection<S>(stream: S, peer: SocketAddr, app: Router, handshake_timeout: Duration)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
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
