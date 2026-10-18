//! Message routing: the routing decision table from architecture §5.2.
//!
//! Dependency direction: `transport` depends on `rooms` and `relay`; `relay`
//! calls back only through the `rooms::LocalDelivery` trait.

use std::time::Instant;

use crate::metrics::names;
use crate::protocol::{self, messages, Classification};
use crate::relay::{CrossKind, CrossNodeMsg, JoinStatus};
use crate::rooms::{generate_room_code, PeerId, RoomCode, RoomError, MAX_ROOM_MEMBERS};

use super::heartbeat;
use super::seat::{SeatRole, VerifyResult};
use super::{ConnCtx, ConnDeps};

/// Maximum attempts when generating a fresh room code (architecture §9.4).
pub const MAX_GENERATE_RETRIES: usize = 16;

/// Internal outcome of a create attempt.
enum CreateOutcome {
    Created,
    Exists,
    Capacity,
    Internal,
}

/// Build the `{node_id}:{peer_id}` member key used in the Redis member set.
pub fn member_id(node_id: &str, peer: &PeerId) -> String {
    format!("{node_id}:{peer}")
}

/// The router: turns classified frames into room/relay actions.
pub struct Router {
    deps: ConnDeps,
}

impl Router {
    /// Build a router over the connection dependencies.
    pub fn new(deps: ConnDeps) -> Self {
        Self { deps }
    }

    /// Handle one raw inbound text frame.
    pub async fn handle(&self, ctx: &ConnCtx, raw: &str) {
        match protocol::classify(raw) {
            Classification::Ignore => {}
            Classification::UnknownType => {
                self.deps.metrics.inc_error(names::err_kind::UNKNOWN_TYPE);
                ctx.send(messages::error(messages::ERR_UNKNOWN_TYPE));
            }
            Classification::Create { room } => self.handle_create(ctx, room).await,
            Classification::Join { room, name } => self.handle_join(ctx, &room, &name).await,
            Classification::Signal { data } => self.handle_signal(ctx, data).await,
            Classification::Leave => self.leave_current(ctx).await,
            // v1.1: `ping` never touches room/connection state — reply and move
            // on. It works in *any* state (not in a room / in a room / in grace).
            Classification::Ping { ts } => {
                self.deps.metrics.inc_message(names::msg_type::PING);
                ctx.send(messages::pong(ts));
            }
            Classification::Resume {
                room,
                peer_id,
                token,
            } => self.handle_resume(ctx, &room, &peer_id, &token).await,
        }
    }

    async fn handle_create(&self, ctx: &ConnCtx, room: Option<String>) {
        // v1 leaves the previous room *before* validating the new code.
        if ctx.current_room().is_some() {
            self.leave_current(ctx).await;
        }

        match room {
            Some(raw) => match RoomCode::new(&raw) {
                Ok(code) => match self.attempt_create(ctx, &code).await {
                    CreateOutcome::Created => {}
                    CreateOutcome::Exists => {
                        self.deps.metrics.inc_error(names::err_kind::ROOM_EXISTS);
                        ctx.send(messages::error(messages::err_room_exists(code.as_str())));
                    }
                    CreateOutcome::Capacity | CreateOutcome::Internal => {
                        self.deps.metrics.inc_error(names::err_kind::INTERNAL);
                        ctx.send(messages::error(messages::ERR_SERVER_BUSY));
                    }
                },
                Err(_) => {
                    self.deps.metrics.inc_error(names::err_kind::ROOM_FORMAT);
                    ctx.send(messages::error(messages::ERR_ROOM_FORMAT));
                }
            },
            None => self.create_with_generated_code(ctx).await,
        }
    }

    async fn create_with_generated_code(&self, ctx: &ConnCtx) {
        for _ in 0..MAX_GENERATE_RETRIES {
            let code = generate_room_code();
            match self.attempt_create(ctx, &code).await {
                CreateOutcome::Created => return,
                CreateOutcome::Exists => continue,
                CreateOutcome::Capacity | CreateOutcome::Internal => {
                    self.deps.metrics.inc_error(names::err_kind::INTERNAL);
                    ctx.send(messages::error(messages::ERR_SERVER_BUSY));
                    return;
                }
            }
        }
        self.deps.metrics.inc_error(names::err_kind::INTERNAL);
        ctx.send(messages::error(messages::ERR_SERVER_BUSY));
    }

    async fn attempt_create(&self, ctx: &ConnCtx, code: &RoomCode) -> CreateOutcome {
        let ttl = self.deps.cfg.snapshot().redis.room_ttl_secs;
        let peer = ctx.peer_id();
        let member = member_id(&self.deps.node_id, &peer);
        let registry_outcome = self.deps.relay.registry_create(code, &member, ttl).await;
        let registered = match registry_outcome {
            Ok(ok) => ok,
            // Degraded (no Redis): fall back to local uniqueness.
            Err(_) => !self.deps.rooms.contains(code),
        };
        // F6: only a *successful* Redis SADD needs rollback on local failure.
        let redis_registered = matches!(registry_outcome, Ok(true));
        if !registered {
            return CreateOutcome::Exists;
        }
        match self.deps.rooms.create(code.clone(), ctx.handle()) {
            Ok(()) => {
                ctx.set_room(code.clone());
                // v1.1: a seat is issued *before* `created` so the client can
                // resume with the token it just received.
                let token = self.deps.seats.issue(
                    &peer,
                    code,
                    "",
                    SeatRole::Host,
                    ctx.conn_id,
                    heartbeat::now_ms(),
                );
                ctx.send(messages::created_with_token(code.as_str(), peer.as_str(), &token));
                self.deps.relay.subscribe_room(code).await;
                self.deps.metrics.inc_message(names::msg_type::CREATE);
                tracing::info!(
                    node_id = %self.deps.node_id,
                    peer_id = %peer,
                    room = %code,
                    "房间创建"
                );
                CreateOutcome::Created
            }
            Err(err) => {
                // F6: Redis 已 SADD，本地准入失败 → 幂等回滚（SREM），
                // 否则陈旧成员会把房间号永久占位（重启前一直报「已存在」）。
                if redis_registered {
                    let _ = self.deps.relay.registry_leave(code, &member).await;
                }
                match err {
                    RoomError::Exists => CreateOutcome::Exists,
                    RoomError::Capacity => CreateOutcome::Capacity,
                    _ => CreateOutcome::Internal,
                }
            }
        }
    }

    async fn handle_join(&self, ctx: &ConnCtx, room: &str, name: &str) {
        // v1 leaves the previous room before attempting the join.
        if ctx.current_room().is_some() {
            self.leave_current(ctx).await;
        }

        // v1 does not format-validate `join`; an invalid code is simply "not found".
        let code = match RoomCode::new(room) {
            Ok(c) => c,
            Err(_) => {
                let display = room.to_uppercase();
                self.deps.metrics.inc_error(names::err_kind::ROOM_NOT_FOUND);
                ctx.send(messages::error(messages::err_room_not_found(&display)));
                return;
            }
        };

        let ttl = self.deps.cfg.snapshot().redis.room_ttl_secs;
        let peer = ctx.peer_id();
        let member = member_id(&self.deps.node_id, &peer);
        let registry_outcome = self.deps.relay.registry_join(&code, &member, ttl).await;
        // F6: only a *successful* Redis SADD needs rollback on local failure.
        let (status, redis_joined) = match registry_outcome {
            Ok(status) => (status, status == JoinStatus::Joined),
            Err(_) => {
                let fallback = if !self.deps.rooms.contains(&code) {
                    JoinStatus::NotFound
                } else if self.deps.rooms.len_of(&code) >= MAX_ROOM_MEMBERS {
                    JoinStatus::Full
                } else {
                    JoinStatus::Joined
                };
                (fallback, false)
            }
        };
        match status {
            JoinStatus::NotFound => {
                self.deps.metrics.inc_error(names::err_kind::ROOM_NOT_FOUND);
                ctx.send(messages::error(messages::err_room_not_found(code.as_str())));
                return;
            }
            JoinStatus::Full => {
                self.deps.metrics.inc_error(names::err_kind::ROOM_FULL);
                ctx.send(messages::error(messages::ERR_ROOM_FULL));
                return;
            }
            JoinStatus::Joined => {}
        }

        // Register locally; if the room is not local yet this is the cross-node
        // case (it exists globally) and we create the local entry.
        let existing = match self.deps.rooms.join(&code, ctx.handle()) {
            Ok(existing) => existing,
            Err(RoomError::NotFound) => {
                match self.deps.rooms.join_or_create(&code, ctx.handle()) {
                    Ok(existing) => existing,
                    Err(RoomError::Full) => {
                        self.compensate_registry_join(&code, &member, redis_joined)
                            .await;
                        self.deps.metrics.inc_error(names::err_kind::ROOM_FULL);
                        ctx.send(messages::error(messages::ERR_ROOM_FULL));
                        return;
                    }
                    Err(RoomError::Capacity) => {
                        self.compensate_registry_join(&code, &member, redis_joined)
                            .await;
                        self.deps.metrics.inc_error(names::err_kind::INTERNAL);
                        ctx.send(messages::error(messages::ERR_SERVER_BUSY));
                        return;
                    }
                    Err(_) => Vec::new(),
                }
            }
            Err(RoomError::Full) => {
                self.compensate_registry_join(&code, &member, redis_joined)
                    .await;
                self.deps.metrics.inc_error(names::err_kind::ROOM_FULL);
                ctx.send(messages::error(messages::ERR_ROOM_FULL));
                return;
            }
            Err(_) => Vec::new(),
        };

        // F5: subscribe to the room channel *before* any cross-node publish —
        // the old order (publish → subscribe) could lose the very first
        // `peer-joined` packet on the remote node (first-packet race).
        self.deps.relay.subscribe_room(&code).await;

        let name = protocol::truncate_name(name);
        let token = self.deps.seats.issue(
            &peer,
            &code,
            &name,
            SeatRole::Guest,
            ctx.conn_id,
            heartbeat::now_ms(),
        );

        ctx.set_room(code.clone());
        ctx.send(messages::joined_with_token(code.as_str(), peer.as_str(), &token));
        self.deps.metrics.inc_message(names::msg_type::JOIN);

        if existing.is_empty() {
            // The existing peer lives on another node: notify it via the channel.
            let msg = CrossNodeMsg::new(
                CrossKind::PeerJoined,
                &code,
                &self.deps.node_id,
                &peer,
            )
            .with_name(&name);
            if self.deps.relay.publish(msg).await.is_err() {
                self.deps
                    .metrics
                    .inc_error(names::err_kind::RELAY_UNAVAILABLE);
            }
        } else {
            for handle in existing {
                if handle.send(messages::peer_joined(peer.as_str(), &name)) {
                    self.deps.metrics.inc_error(names::err_kind::SLOW_CLIENT);
                }
            }
        }
        tracing::info!(
            node_id = %self.deps.node_id,
            peer_id = %peer,
            room = %code,
            "加入房间"
        );
    }

    /// F6: roll back a successful Redis `SADD` when the local admission
    /// failed (idempotent SREM via `registry_leave`). A no-op in degraded
    /// mode, where no SADD ever happened.
    async fn compensate_registry_join(&self, code: &RoomCode, member: &str, redis_joined: bool) {
        if redis_joined {
            let _ = self.deps.relay.registry_leave(code, member).await;
        }
    }

    async fn handle_signal(&self, ctx: &ConnCtx, data: serde_json::Value) {
        let started = Instant::now();
        let Some(code) = ctx.current_room() else {
            return; // sender not in a room → silently dropped (v1)
        };
        let peer = ctx.peer_id();
        let targets = self.deps.rooms.signal_targets(&code, &peer);
        if targets.is_empty() {
            // No local peer → the peer (if any) is on another node: relay it.
            let msg = CrossNodeMsg::new(CrossKind::Signal, &code, &self.deps.node_id, &peer)
                .with_payload(data);
            match self.deps.relay.publish(msg).await {
                Ok(()) => self.deps.metrics.inc_message(names::msg_type::SIGNAL),
                Err(_) => {
                    self.deps
                        .metrics
                        .inc_error(names::err_kind::RELAY_UNAVAILABLE);
                }
            }
        } else {
            for handle in targets {
                if handle.is_closed() {
                    // Opponent socket is dropped and in grace window: silently drop.
                    continue;
                }
                if handle.send(messages::signal(data.clone())) {
                    self.deps.metrics.inc_error(names::err_kind::SLOW_CLIENT);
                }
            }
            self.deps.metrics.inc_message(names::msg_type::SIGNAL);
        }
        self.deps
            .metrics
            .observe_signal_latency(started.elapsed().as_secs_f64());
    }

    async fn handle_resume(&self, ctx: &ConnCtx, room: &str, peer_id: &str, token: &str) {
        let code = match RoomCode::new(room) {
            Ok(c) => c,
            Err(_) => {
                self.deps.metrics.inc_error(names::err_kind::RESUME_REJECTED);
                ctx.send(messages::error_with_code(
                    messages::ERR_RESUME_REJECTED,
                    messages::code::RESUME_REJECTED,
                ));
                return;
            }
        };
        let peer = match PeerId::new(peer_id) {
            Ok(p) => p,
            Err(_) => {
                self.deps.metrics.inc_error(names::err_kind::RESUME_REJECTED);
                ctx.send(messages::error_with_code(
                    messages::ERR_RESUME_REJECTED,
                    messages::code::RESUME_REJECTED,
                ));
                return;
            }
        };

        let now = heartbeat::now_ms();
        match self.deps.seats.verify(&peer, &code, token, now) {
            VerifyResult::Ok => {}
            VerifyResult::Invalid => {
                self.deps
                    .metrics
                    .inc_error(names::err_kind::RESUME_TOKEN_INVALID);
                ctx.send(messages::error_with_code(
                    messages::ERR_RESUME_TOKEN_INVALID,
                    messages::code::RESUME_TOKEN_INVALID,
                ));
                return;
            }
            VerifyResult::Expired | VerifyResult::Unknown => {
                self.deps.metrics.inc_error(names::err_kind::RESUME_REJECTED);
                ctx.send(messages::error_with_code(
                    messages::ERR_RESUME_REJECTED,
                    messages::code::RESUME_REJECTED,
                ));
                return;
            }
        }

        let rebound_handle = ctx.adopt_peer(peer.clone());
        if !self.deps.rooms.rebind(&code, &peer, rebound_handle) {
            self.deps.metrics.inc_error(names::err_kind::RESUME_REJECTED);
            ctx.send(messages::error_with_code(
                messages::ERR_RESUME_REJECTED,
                messages::code::RESUME_REJECTED,
            ));
            return;
        }

        let Some(new_token) = self.deps.seats.rotate(&peer, ctx.conn_id, now) else {
            self.deps.metrics.inc_error(names::err_kind::RESUME_REJECTED);
            ctx.send(messages::error_with_code(
                messages::ERR_RESUME_REJECTED,
                messages::code::RESUME_REJECTED,
            ));
            return;
        };

        ctx.set_room(code.clone());
        self.deps.relay.subscribe_room(&code).await;

        let targets = self.deps.rooms.signal_targets(&code, &peer);
        let peer_present = !targets.is_empty();

        ctx.send(messages::resumed(
            code.as_str(),
            peer.as_str(),
            &new_token,
            peer_present,
        ));
        self.deps.metrics.inc_message(names::msg_type::RESUME);

        if targets.is_empty() {
            let msg = CrossNodeMsg::new(CrossKind::PeerOnline, &code, &self.deps.node_id, &peer);
            if self.deps.relay.publish(msg).await.is_err() && !self.deps.relay.is_connected() {
                self.deps.metrics.inc_error(names::err_kind::RELAY_UNAVAILABLE);
            }
        } else {
            for handle in targets {
                if handle.send(messages::peer_online()) {
                    self.deps.metrics.inc_error(names::err_kind::SLOW_CLIENT);
                }
            }
        }

        tracing::info!(
            node_id = %self.deps.node_id,
            peer_id = %peer,
            room = %code,
            grace_ms = self.deps.seats.grace_ms(),
            "srv.resume.ok"
        );
    }

    async fn leave_current(&self, ctx: &ConnCtx) {
        if let Some(code) = ctx.take_room() {
            let peer = ctx.peer_id();
            self.deps.seats.release(&peer);
            do_leave(&self.deps, &peer, &code).await;
        }
    }
}

/// Shared leave routine used by both the router and the RAII guard.
pub async fn do_leave(deps: &ConnDeps, peer: &PeerId, code: &RoomCode) {
    let member = member_id(&deps.node_id, peer);
    let _ = deps.relay.registry_leave(code, &member).await;

    let outcome = deps.rooms.leave(code, peer);
    if outcome.destroyed {
        deps.relay.unsubscribe_room(code).await;
    }
    if outcome.remaining.is_empty() {
        // No local peer left → the remaining peer (if any) is remote.
        let msg = CrossNodeMsg::new(CrossKind::PeerLeft, code, &deps.node_id, peer);
        if deps.relay.publish(msg).await.is_err() && !deps.relay.is_connected() {
            deps.metrics.inc_error(names::err_kind::RELAY_UNAVAILABLE);
        }
    } else {
        for handle in outcome.remaining {
            if handle.send(messages::peer_left()) {
                deps.metrics.inc_error(names::err_kind::SLOW_CLIENT);
            }
        }
    }
    deps.metrics.inc_message(names::msg_type::LEAVE);
    tracing::info!(
        node_id = %deps.node_id,
        peer_id = %peer,
        room = %code,
        "离开房间"
    );
}
