//! `GET /signal` — WS upgrade: origin check → shutdown guard → admission →
//! handshake timeout → spawn the connection task.

use std::net::{IpAddr, SocketAddr};

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::metrics::names;
use crate::transport::connection;
use crate::transport::registry::AdmitResult;

use super::AppState;

/// Upgrade handler for `/signal`.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !origin_allowed(&state, &headers) {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    if state.shutdown.is_shutdown() {
        return (StatusCode::SERVICE_UNAVAILABLE, "Shutting down").into_response();
    }

    let ip = client_ip(&state, addr, &headers);
    match state.conns.admit(ip) {
        AdmitResult::Admitted(admission) => {
            let deps = state.conn_deps();
            let shutdown = state.shutdown.clone();

            // The `ws_handshake_timeout_secs` limit is enforced at the
            // connection level by `http::serve` (hyper `header_read_timeout`),
            // which also covers clients that open the socket but never send a
            // request — something an axum-layer timeout cannot do.
            ws.on_upgrade(move |socket| {
                connection::run_connection(socket, deps, admission, shutdown)
            })
        }
        AdmitResult::RejectedGlobal | AdmitResult::RejectedPerIp => {
            state.metrics.inc_error(names::err_kind::REJECTED);
            (StatusCode::SERVICE_UNAVAILABLE, "Too many connections").into_response()
        }
    }
}

/// Resolve the client IP for per-IP limiting.
///
/// By default the socket peer address is used. `X-Forwarded-For` (left-most
/// entry) is honoured only when `server.trust_proxy_headers` is `true` — the
/// header is spoofable, so trusting it by default would defeat the per-IP limit
/// (PRD §12-Q7).
pub fn client_ip(state: &AppState, addr: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let trust_proxy = state.cfg.snapshot().server.trust_proxy_headers;
    if trust_proxy {
        if let Some(forwarded) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
        {
            if let Ok(ip) = forwarded.trim().parse::<IpAddr>() {
                return ip;
            }
        }
    }
    addr.ip()
}

/// Whether the WS `Origin` is acceptable.
///
/// An empty `allowed_ws_origins` means "do not validate" (v1 behaviour);
/// otherwise only listed origins are accepted.
pub fn origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    let allowed = state.cfg.snapshot().server.allowed_ws_origins.clone();
    if allowed.is_empty() {
        return true;
    }
    match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(origin) => allowed.iter().any(|o| o == origin),
        None => false,
    }
}
