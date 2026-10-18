//! Per-connection lifecycle: reader task + writer task, heartbeat, and the RAII
//! guard that settles the seat when the socket drops.
//!
//! ## Disconnect ≠ leave (v1.1)
//!
//! A dropped socket keeps the seat: the room entry stays in the table, the peer
//! id stays valid, and the opponent only receives `peer-offline{graceSec}`.
//! `peer-left` is emitted later, by the sweep, once the grace window expires —
//! which is exactly the frozen v1 semantics for clients that never resume.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::watch;
use tokio::sync::{mpsc, Notify};
use tokio::time::MissedTickBehavior;

use crate::metrics::names;
use crate::protocol::{messages, ServerMsg};
use crate::relay::{CrossKind, CrossNodeMsg};
use crate::rooms::{generate_peer_id, outbound_channel, ConnHandle};

use super::heartbeat;
use super::registry::ConnAdmission;
use super::router::Router;
use super::shutdown::Shutdown;
use super::{ConnCtx, ConnDeps};

/// Monotonic physical-connection id.
///
/// A process-wide counter is enough: it only has to be unique *within this
/// node's seat table* (seats are node-local).
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// Allocate a fresh physical-connection id.
fn next_conn_id() -> u64 {
    NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed)
}

/// Control frames the reader forwards to the writer (pong replies, close).
enum WriterCmd {
    Pong(Vec<u8>),
    Close(u16, &'static str),
}

/// Build a close frame with the given code.
fn close_frame(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

/// Run one connection to completion. Returns after the socket is closed and the
/// room has been left.
pub async fn run_connection(
    socket: WebSocket,
    deps: ConnDeps,
    admission: ConnAdmission,
    shutdown: Shutdown,
) {
    // Held until the connection ends: releases global/per-IP counters on drop.
    let _admission = admission;
    let ticket = shutdown.register_connection();

    let peer_id = generate_peer_id();
    let conn_id = next_conn_id();
    let capacity = deps.cfg.snapshot().limits.broadcast_queue_capacity as usize;
    let (tx, rx) = outbound_channel(capacity);
    let slow = Arc::new(Notify::new());
    let handle = ConnHandle::new(peer_id.clone(), deps.node_id.clone(), tx, slow.clone());
    let ctx = ConnCtx::new(conn_id, peer_id.clone(), deps.node_id.clone(), handle.clone());
    let guard = ConnectionGuard::new(deps.clone(), ctx.clone());

    deps.metrics.set_ws_connections(deps.conns.current());
    tracing::info!(node_id = %deps.node_id, peer_id = %peer_id, conn_id, "连接建立");

    let (ping_secs, idle_secs) = {
        let cfg = deps.cfg.snapshot();
        (
            cfg.timeouts.ws_ping_interval_secs,
            cfg.timeouts.ws_idle_timeout_secs,
        )
    };
    let max_message = deps.cfg.snapshot().limits.max_message_bytes;

    let (sink, mut stream) = socket.split();
    let last_seen = Arc::new(AtomicU64::new(heartbeat::now_ms()));
    let (cmd_tx, cmd_rx) = mpsc::channel(8);
    let writer = tokio::spawn(write_loop(
        sink,
        rx,
        cmd_rx,
        ping_secs,
        idle_secs,
        last_seen.clone(),
        slow.clone(),
        shutdown.subscribe(),
    ));

    let router = Router::new(deps.clone());
    let mut shutdown_rx = shutdown.subscribe();

    loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => break,
            frame = stream.next() => {
                match frame {
                    None | Some(Err(_)) => break,
                    Some(Ok(message)) => {
                        last_seen.store(heartbeat::now_ms(), Ordering::Relaxed);
                        match message {
                            Message::Text(text) => {
                                let text = text.as_str();
                                if text.len() > max_message {
                                    deps.metrics.inc_error(names::err_kind::MESSAGE_TOO_LARGE);
                                    continue;
                                }
                                router.handle(&ctx, text).await;
                            }
                            Message::Binary(_) => {}
                            Message::Ping(payload) => {
                                let _ = cmd_tx.try_send(WriterCmd::Pong(payload.to_vec()));
                            }
                            Message::Pong(_) => {}
                            Message::Close(_) => break,
                        }
                    }
                }
            }
        }
    }

    // Stop the writer deterministically, then settle the seat.
    let _ = cmd_tx.try_send(WriterCmd::Close(1001, "going away"));
    drop(cmd_tx);
    let _ = writer.await;
    drop(guard);
    drop(ctx);
    drop(handle);
    drop(ticket);
    deps.metrics.set_ws_connections(deps.conns.current());
    tracing::info!(node_id = %deps.node_id, peer_id = %peer_id, conn_id, "连接关闭");
}

/// Settle the seat of a connection that just ended.
///
/// Order matters and is not negotiable:
/// 1. a *stale* connection (already superseded by a successful `resume`) does
///    nothing — otherwise the freshly restored seat would be pushed straight
///    back into the grace window;
/// 2. a connection that never joined a room does nothing;
/// 3. `mark_offline` is idempotent, so `close` + `error` cannot broadcast
///    `peer-offline` twice;
/// 4. the room is **not** left — that is what makes resume cheap (ADR-7).
pub async fn on_disconnect(deps: &ConnDeps, ctx: &ConnCtx) {
    let peer = ctx.peer_id();
    if !deps.seats.is_owner(&peer, ctx.conn_id) {
        return;
    }
    let Some(code) = ctx.current_room() else {
        return;
    };
    let now = heartbeat::now_ms();
    let Some(_seat) = deps.seats.mark_offline(&peer, now) else {
        return;
    };

    let grace_secs = deps.seats.grace_secs();
    let targets = deps.rooms.signal_targets(&code, &peer);
    if targets.is_empty() {
        // The opponent (if any) lives on another node.
        let msg = CrossNodeMsg::new(CrossKind::PeerOffline, &code, &deps.node_id, &peer)
            .with_grace(grace_secs);
        if deps.relay.publish(msg).await.is_err() && deps.relay.is_connected() {
            deps.metrics.inc_error(names::err_kind::RELAY_UNAVAILABLE);
        }
    } else {
        for handle in targets {
            if handle.send(messages::peer_offline(grace_secs)) {
                deps.metrics.inc_error(names::err_kind::SLOW_CLIENT);
            }
        }
    }
    tracing::info!(
        node_id = %deps.node_id,
        peer_id = %peer,
        room = %code,
        grace_ms = deps.seats.grace_ms(),
        "srv.grace.start"
    );
}

#[allow(clippy::too_many_arguments)]
async fn write_loop(
    mut sink: SplitSink<WebSocket, Message>,
    mut rx: mpsc::Receiver<ServerMsg>,
    mut cmd_rx: mpsc::Receiver<WriterCmd>,
    ping_secs: u64,
    idle_secs: u64,
    last_seen: Arc<AtomicU64>,
    slow: Arc<Notify>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(ping_secs.max(1)));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => {
                let _ = sink.send(close_frame(1001, "server shutdown")).await;
                break;
            }
            _ = slow.notified() => {
                let _ = sink.send(close_frame(1001, "slow client")).await;
                break;
            }
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    WriterCmd::Pong(bytes) => {
                        if sink.send(Message::Pong(bytes)).await.is_err() {
                            break;
                        }
                    }
                    WriterCmd::Close(code, reason) => {
                        let _ = sink.send(close_frame(code, reason)).await;
                        break;
                    }
                }
            }
            Some(msg) = rx.recv() => {
                if sink.send(Message::Text(msg.encode())).await.is_err() {
                    break;
                }
            }
            _ = interval.tick() => {
                let now = heartbeat::now_ms();
                if heartbeat::is_dead(now, last_seen.load(Ordering::Relaxed), idle_secs) {
                    let _ = sink.send(close_frame(1001, "idle timeout")).await;
                    break;
                }
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = sink.close().await;
}

/// RAII guard: on drop, the connection settles its seat (offline + broadcast)
/// instead of leaving the room. Local cleanup is synchronous; the Redis side
/// runs on a spawned task.
pub struct ConnectionGuard {
    deps: ConnDeps,
    ctx: ConnCtx,
}

impl ConnectionGuard {
    /// Build a guard for `ctx`.
    pub fn new(deps: ConnDeps, ctx: ConnCtx) -> Self {
        Self { deps, ctx }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        let deps = self.deps.clone();
        let ctx = self.ctx.clone();
        tokio::spawn(async move {
            on_disconnect(&deps, &ctx).await;
        });
    }
}
