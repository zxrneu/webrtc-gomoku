//! Cross-node relay: Redis pub/sub publishing, per-room dynamic subscription,
//! global room registration (Lua) and resilient reconnection.
//!
//! `relay` never depends on concrete `transport` types: incoming cross-node
//! events are handed back through the [`LocalDelivery`] trait implemented by
//! `rooms` (dependency inversion, AGENTS.md §2 D).
//!
//! ## Startup must not block on Redis
//!
//! Redis is an *optional* dependency: when it is unreachable the node must
//! still bind its port and serve local rooms. [`build`] therefore returns
//! immediately and establishes the connection on a background task, retrying
//! with a true `1s → 30s` exponential backoff ([`backoff_delay`]) until Redis
//! appears (or the process shuts down).

pub mod message;
pub mod registry;
pub mod subscriber;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwapOption;
use async_trait::async_trait;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use thiserror::Error;
use tokio::sync::{mpsc, watch};

use crate::config::{Config, ConfigSnapshot, RedisConfig};
use crate::metrics::Metrics;
use crate::rooms::{LocalDelivery, PeerId, RoomCode, RoomTable};
use crate::transport::seat::ResumeError;

pub use message::{CrossKind, CrossNodeMsg, PROTOCOL_VERSION};
pub use registry::{
    members_key, room_channel, room_key, JoinStatus, LeaveStatus, RedisRoomRegistry, CREATE_LUA,
    JOIN_LUA, LEAVE_LUA, REFRESH_LUA,
};
pub use subscriber::{SubCommand, SubscriberDeps};

/// Grant payload when resuming a seat across nodes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeGrant {
    /// Node ID that previously hosted the seat.
    pub old_node: String,
    /// Player display name.
    pub name: String,
    /// Player role ("host" or "guest").
    pub role: String,
}

/// Control-channel capacity for subscription commands.
pub const CONTROL_CAPACITY: usize = 4096;

/// Initial delay before the first Redis reconnect attempt (seconds).
pub const BACKOFF_START_SECS: u64 = 1;
/// Maximum delay between Redis reconnect attempts (seconds).
pub const BACKOFF_MAX_SECS: u64 = 30;

/// Exponential reconnect delay for the `attempt`-th retry (0-based):
/// `1s, 2s, 4s, 8s, 16s, 30s, 30s, …`.
///
/// This is a *true* `1s → 30s` backoff: the first retry is 1 second, not the
/// 30-second cap (the previous implementation jumped straight to the cap on the
/// first retry, which is why an unreachable Redis stalled startup for minutes).
pub fn backoff_delay(attempt: u32) -> Duration {
    let secs = 1u64.checked_shl(attempt).unwrap_or(u64::MAX);
    Duration::from_secs(secs.min(BACKOFF_MAX_SECS))
}

/// Relay-layer errors.
#[derive(Debug, Error)]
pub enum RelayError {
    /// Redis is not reachable / not configured.
    #[error("Redis 不可用: {0}")]
    Unavailable(String),
    /// A Redis command failed.
    #[error("Redis 命令失败: {0}")]
    Command(String),
}

/// Cross-node relay surface used by the router (object-safe for test doubles).
#[async_trait]
pub trait Relay: Send + Sync {
    /// Publish a cross-node event to the room channel.
    async fn publish(&self, msg: CrossNodeMsg) -> Result<(), RelayError>;

    /// Ensure the room channel is subscribed.
    async fn subscribe_room(&self, code: &RoomCode);

    /// Drop the room channel subscription.
    async fn unsubscribe_room(&self, code: &RoomCode);

    /// Globally create a room (`SET NX EX`).
    async fn registry_create(
        &self,
        code: &RoomCode,
        member: &str,
        ttl_secs: u64,
    ) -> Result<bool, RelayError>;

    /// Globally join a room.
    async fn registry_join(
        &self,
        code: &RoomCode,
        member: &str,
        ttl_secs: u64,
    ) -> Result<JoinStatus, RelayError>;

    /// Globally leave a room.
    async fn registry_leave(
        &self,
        code: &RoomCode,
        member: &str,
    ) -> Result<LeaveStatus, RelayError>;

    /// Refresh the Redis TTL of the given live rooms (F4 background
    /// keep-alive). Called **only** by the periodic refresher — never on the
    /// per-message hot path (which must stay RTT-free). Default: no-op.
    async fn refresh_rooms(&self, _codes: &[RoomCode], _ttl_secs: u64) {}

    /// Issue or update a seat in the global registry (Issue 3).
    #[allow(clippy::too_many_arguments)]
    async fn registry_issue_seat(
        &self,
        _code: &RoomCode,
        _peer: &PeerId,
        _token: &str,
        _name: &str,
        _role: &str,
        _node_id: &str,
        _ttl_secs: u64,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    /// Mark a seat as offline in the global registry (Issue 3).
    async fn registry_seat_offline(
        &self,
        _code: &RoomCode,
        _peer: &PeerId,
        _now_ms: u64,
        _expires_at_ms: u64,
        _ttl_secs: u64,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    /// Delete a seat from the global registry.
    async fn registry_leave_seat(
        &self,
        _code: &RoomCode,
        _peer: &PeerId,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    /// Atomically resume a seat across nodes (Issue 3).
    #[allow(clippy::too_many_arguments)]
    async fn registry_resume_seat(
        &self,
        _code: &RoomCode,
        _peer: &PeerId,
        _token: &str,
        _new_token: &str,
        _node_id: &str,
        _now_ms: u64,
        _ttl_secs: u64,
    ) -> Result<ResumeGrant, ResumeError> {
        Err(ResumeError::Unknown)
    }

    /// Query current room members from global registry (Issue 2).
    async fn registry_room_members(&self, _code: &RoomCode) -> Result<Vec<String>, RelayError> {
        Err(RelayError::Unavailable("未配置 Redis".into()))
    }

    /// Whether Redis is configured/available.
    fn is_connected(&self) -> bool;
}

/// A small round-robin pool of auto-reconnecting Redis connections.
pub struct RedisPool {
    managers: Vec<ConnectionManager>,
    cursor: std::sync::atomic::AtomicUsize,
}

impl RedisPool {
    /// Connect `pool_size` managers **concurrently**.
    ///
    /// Each manager makes a *single* attempt (no in-library backoff) so that an
    /// unreachable Redis fails fast; the caller (`connect_then_subscribe`) owns
    /// the `1s → 30s` retry cadence. Connecting the managers concurrently keeps
    /// the worst case at one `connection_timeout` rather than `pool_size ×`.
    pub async fn connect(cfg: &RedisConfig) -> Result<Self, RelayError> {
        let client = redis::Client::open(cfg.url.clone())
            .map_err(|e| RelayError::Unavailable(e.to_string()))?;
        let size = cfg.pool_size.max(1) as usize;
        let timeout = Duration::from_millis(cfg.connect_timeout_ms);

        let attempts = (0..size).map(|_| {
            let client = client.clone();
            async move {
                let config = ConnectionManagerConfig::new()
                    .set_number_of_retries(0)
                    .set_connection_timeout(timeout)
                    .set_response_timeout(timeout);
                client
                    .get_connection_manager_with_config(config)
                    .await
                    .map_err(|e| RelayError::Unavailable(e.to_string()))
            }
        });

        let managers = futures_util::future::try_join_all(attempts).await?;
        Ok(Self {
            managers,
            cursor: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    /// Borrow a connection (round-robin).
    pub fn get(&self) -> Result<ConnectionManager, RelayError> {
        if self.managers.is_empty() {
            return Err(RelayError::Unavailable("连接池为空".into()));
        }
        let idx = self.cursor.fetch_add(1, Ordering::Relaxed) % self.managers.len();
        Ok(self.managers[idx].clone())
    }

    /// Pool size.
    pub fn len(&self) -> usize {
        self.managers.len()
    }

    /// Whether the pool is empty.
    pub fn is_empty(&self) -> bool {
        self.managers.is_empty()
    }
}

/// The production relay implementation.
///
/// The Redis handles are installed *after* the background connection succeeds;
/// until then every method degrades to [`RelayError::Unavailable`] and the
/// router falls back to local-only handling. `ArcSwapOption` keeps the hot path
/// lock-free once installed.
pub struct RelayManager {
    pool: ArcSwapOption<RedisPool>,
    registry: ArcSwapOption<RedisRoomRegistry>,
    control: ArcSwapOption<mpsc::Sender<SubCommand>>,
    prefix: String,
    connected: Arc<AtomicBool>,
}

impl RelayManager {
    /// A relay with no Redis yet: everything degrades to local-only.
    pub fn disabled(prefix: impl Into<String>) -> Self {
        Self {
            pool: ArcSwapOption::empty(),
            registry: ArcSwapOption::empty(),
            control: ArcSwapOption::empty(),
            prefix: prefix.into(),
            connected: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Publish the live Redis handles (called once the background connect
    /// succeeds).
    fn install(
        &self,
        pool: Arc<RedisPool>,
        registry: Arc<RedisRoomRegistry>,
        control: mpsc::Sender<SubCommand>,
    ) {
        self.pool.store(Some(pool));
        self.registry.store(Some(registry));
        self.control.store(Some(Arc::new(control)));
        self.connected.store(true, Ordering::Relaxed);
    }
}

#[async_trait]
impl Relay for RelayManager {
    async fn publish(&self, msg: CrossNodeMsg) -> Result<(), RelayError> {
        let Some(pool) = self.pool.load_full() else {
            return Err(RelayError::Unavailable("未配置 Redis".into()));
        };
        let payload = msg
            .encode()
            .map_err(|e| RelayError::Command(e.to_string()))?;
        let channel = format!("{}:room:{}", self.prefix, msg.room);
        let mut conn = pool.get()?;
        let _: i64 = redis::cmd("PUBLISH")
            .arg(channel)
            .arg(payload)
            .query_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        Ok(())
    }

    async fn subscribe_room(&self, code: &RoomCode) {
        if let Some(tx) = self.control.load_full() {
            let _ = tx.send(SubCommand::Subscribe(code.clone())).await;
        }
    }

    async fn unsubscribe_room(&self, code: &RoomCode) {
        if let Some(tx) = self.control.load_full() {
            let _ = tx.send(SubCommand::Unsubscribe(code.clone())).await;
        }
    }

    async fn registry_create(
        &self,
        code: &RoomCode,
        member: &str,
        ttl_secs: u64,
    ) -> Result<bool, RelayError> {
        let Some(registry) = self.registry.load_full() else {
            return Err(RelayError::Unavailable("未配置 Redis".into()));
        };
        let node_id = member.split(':').next().unwrap_or_default();
        registry.create(code, node_id, member, ttl_secs).await
    }

    async fn registry_join(
        &self,
        code: &RoomCode,
        member: &str,
        ttl_secs: u64,
    ) -> Result<JoinStatus, RelayError> {
        let Some(registry) = self.registry.load_full() else {
            return Err(RelayError::Unavailable("未配置 Redis".into()));
        };
        registry.join(code, member, ttl_secs).await
    }

    async fn registry_leave(
        &self,
        code: &RoomCode,
        member: &str,
    ) -> Result<LeaveStatus, RelayError> {
        let Some(registry) = self.registry.load_full() else {
            return Err(RelayError::Unavailable("未配置 Redis".into()));
        };
        registry.leave(code, member).await
    }

    async fn refresh_rooms(&self, codes: &[RoomCode], ttl_secs: u64) {
        if codes.is_empty() {
            return;
        }
        let Some(registry) = self.registry.load_full() else {
            return; // degraded / single-node: nothing to refresh
        };
        for code in codes {
            // Best-effort: a failed refresh just means the room may expire
            // earlier than planned — the next tick (≤ ttl/3 later) retries.
            let _ = registry.refresh(code, ttl_secs).await;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn registry_issue_seat(
        &self,
        code: &RoomCode,
        peer: &PeerId,
        token: &str,
        name: &str,
        role: &str,
        node_id: &str,
        ttl_secs: u64,
    ) -> Result<(), RelayError> {
        let Some(registry) = self.registry.load_full() else {
            return Err(RelayError::Unavailable("未配置 Redis".into()));
        };
        registry
            .issue_seat(code, peer, token, name, role, node_id, ttl_secs)
            .await
    }

    async fn registry_seat_offline(
        &self,
        code: &RoomCode,
        peer: &PeerId,
        now_ms: u64,
        expires_at_ms: u64,
        ttl_secs: u64,
    ) -> Result<(), RelayError> {
        let Some(registry) = self.registry.load_full() else {
            return Err(RelayError::Unavailable("未配置 Redis".into()));
        };
        registry
            .seat_offline(code, peer, now_ms, expires_at_ms, ttl_secs)
            .await
    }

    async fn registry_leave_seat(&self, code: &RoomCode, peer: &PeerId) -> Result<(), RelayError> {
        let Some(registry) = self.registry.load_full() else {
            return Err(RelayError::Unavailable("未配置 Redis".into()));
        };
        registry.leave_seat(code, peer).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn registry_resume_seat(
        &self,
        code: &RoomCode,
        peer: &PeerId,
        token: &str,
        new_token: &str,
        node_id: &str,
        now_ms: u64,
        ttl_secs: u64,
    ) -> Result<ResumeGrant, ResumeError> {
        let Some(registry) = self.registry.load_full() else {
            return Err(ResumeError::Unknown);
        };
        registry
            .resume_seat(code, peer, token, new_token, node_id, now_ms, ttl_secs)
            .await
    }

    async fn registry_room_members(&self, code: &RoomCode) -> Result<Vec<String>, RelayError> {
        let Some(registry) = self.registry.load_full() else {
            return Err(RelayError::Unavailable("未配置 Redis".into()));
        };
        registry.room_members(code).await
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }
}

/// Bring up the cross-node relay **without blocking startup**.
///
/// Returns immediately with a (possibly not-yet-connected) [`RelayManager`];
/// a background task establishes the Redis connection, retrying with
/// [`backoff_delay`] until it succeeds, then runs the subscriber loop. When
/// Redis never becomes reachable the node keeps serving local rooms.
///
/// When the relay is switched off in configuration ([`RedisConfig::is_active`]
/// is `false`), **no background task is spawned at all** and the returned handle
/// is `None`. That is the intended single-node deployment: the node behaves
/// exactly as it does during an outage, but without the reconnect churn and the
/// periodic `warn` log.
pub async fn build(
    cfg: &Config,
    delivery: Arc<dyn LocalDelivery>,
    metrics: Arc<Metrics>,
    shutdown_rx: watch::Receiver<bool>,
) -> (Arc<RelayManager>, Option<tokio::task::JoinHandle<()>>) {
    let manager = Arc::new(RelayManager::disabled(cfg.redis.channel_prefix.clone()));

    if !cfg.redis.is_active() {
        metrics.set_redis_connected(false);
        tracing::info!(
            node_id = %cfg.cluster.node_id,
            "Redis 已禁用（redis.enabled=false 或 redis.url 为空），跨节点功能关闭，仅服务本节点房间"
        );
        return (manager, None);
    }

    let deps = SubscriberDeps {
        url: cfg.redis.url.clone(),
        connect_timeout_ms: cfg.redis.connect_timeout_ms,
        prefix: cfg.redis.channel_prefix.clone(),
        node_id: Arc::from(cfg.cluster.node_id.as_str()),
        delivery,
        metrics: metrics.clone(),
    };
    let handle = tokio::spawn(connect_then_subscribe(
        manager.clone(),
        cfg.redis.clone(),
        deps,
        metrics,
        shutdown_rx,
    ));
    (manager, Some(handle))
}

/// Background TTL-refresh period for the room keep-alive (F4).
///
/// At most one third of the room TTL, so a live room is always refreshed
/// well before it can expire (two missed ticks still leave a full third of
/// the TTL as margin). Never below one second, even for a pathologically
/// small TTL.
pub fn ttl_refresh_interval(ttl_secs: u64) -> Duration {
    Duration::from_secs((ttl_secs / 3).max(1))
}

/// Spawn the background room-TTL refresher (F4).
///
/// Every [`ttl_refresh_interval`] the task walks the **local** room table and
/// EXPIREs the corresponding Redis keys (room key + members key). This keeps
/// long-lived rooms (> `room_ttl_secs`, e.g. a >1h game) from expiring
/// mid-match while adding **zero** RTTs to the per-message hot path.
///
/// A live room always has at least one member on some node's local table
/// (`leave` deletes the room when its last member leaves), so local-table
/// traversal covers every live room without a Redis SCAN. The task is a
/// silent no-op while Redis is unavailable.
pub fn spawn_ttl_refresher(
    rooms: Arc<RoomTable>,
    relay: Arc<dyn Relay>,
    cfg: Arc<ConfigSnapshot>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let interval = ttl_refresh_interval(cfg.snapshot().redis.room_ttl_secs);
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        return;
                    }
                }
                _ = tokio::time::sleep(interval) => {}
            }
            if *shutdown_rx.borrow() {
                return;
            }
            let ttl = cfg.snapshot().redis.room_ttl_secs;
            let codes = rooms.room_codes();
            if !codes.is_empty() {
                relay.refresh_rooms(&codes, ttl).await;
            }
        }
    })
}

/// Background connector: retry the pool connect with `1s → 30s` backoff, then
/// hand off to the subscriber loop (which owns its own reconnect cadence).
async fn connect_then_subscribe(
    manager: Arc<RelayManager>,
    redis: RedisConfig,
    deps: SubscriberDeps,
    metrics: Arc<Metrics>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut attempt: u32 = 0;
    loop {
        if *shutdown_rx.borrow() {
            return;
        }
        match RedisPool::connect(&redis).await {
            Ok(pool) => {
                let pool = Arc::new(pool);
                let registry = Arc::new(RedisRoomRegistry::new(
                    pool.clone(),
                    redis.channel_prefix.clone(),
                ));
                let (control_tx, control_rx) = mpsc::channel(CONTROL_CAPACITY);
                manager.install(pool, registry, control_tx);
                metrics.set_redis_connected(true);
                tracing::info!(node_id = %deps.node_id, "Redis 已连接，跨节点功能启用");
                // Runs until shutdown; owns its own reconnect cadence.
                subscriber::run(deps, control_rx, shutdown_rx).await;
                return;
            }
            Err(err) => {
                metrics.set_redis_connected(false);
                let delay = backoff_delay(attempt);
                attempt = attempt.saturating_add(1);
                tracing::warn!(
                    error = %err,
                    delay_secs = delay.as_secs(),
                    "Redis 暂不可用，后台重试（跨节点功能降级为仅本节点）"
                );
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            return;
                        }
                    }
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_true_exponential_one_to_thirty_seconds() {
        assert_eq!(backoff_delay(0), Duration::from_secs(1));
        assert_eq!(backoff_delay(1), Duration::from_secs(2));
        assert_eq!(backoff_delay(2), Duration::from_secs(4));
        assert_eq!(backoff_delay(3), Duration::from_secs(8));
        assert_eq!(backoff_delay(4), Duration::from_secs(16));
        assert_eq!(backoff_delay(5), Duration::from_secs(30));
        assert_eq!(backoff_delay(6), Duration::from_secs(30));
        // The very first retry must NOT jump straight to the cap.
        assert_ne!(backoff_delay(0), Duration::from_secs(30));
        // Never exceeds the cap, for any attempt count.
        for attempt in 0..64 {
            assert!(backoff_delay(attempt) <= Duration::from_secs(BACKOFF_MAX_SECS));
        }
    }

    #[tokio::test]
    async fn disabled_relay_reports_unavailable() {
        let relay = RelayManager::disabled("gomoku:signal");
        assert!(!relay.is_connected());
        let msg = CrossNodeMsg::new(
            CrossKind::Signal,
            &RoomCode::new("ABCD").expect("code"),
            "n",
            &crate::rooms::PeerId::new("aaaaaaaa").expect("peer"),
        );
        assert!(matches!(
            relay.publish(msg).await,
            Err(RelayError::Unavailable(_))
        ));
        assert!(matches!(
            relay
                .registry_create(&RoomCode::new("ABCD").expect("code"), "n:p", 60)
                .await,
            Err(RelayError::Unavailable(_))
        ));
        assert!(matches!(
            relay
                .registry_join(&RoomCode::new("ABCD").expect("code"), "n:p", 60)
                .await,
            Err(RelayError::Unavailable(_))
        ));
        assert!(matches!(
            relay
                .registry_leave(&RoomCode::new("ABCD").expect("code"), "n:p")
                .await,
            Err(RelayError::Unavailable(_))
        ));
        // subscription calls are no-ops, not panics
        relay
            .subscribe_room(&RoomCode::new("ABCD").expect("code"))
            .await;
        relay
            .unsubscribe_room(&RoomCode::new("ABCD").expect("code"))
            .await;
    }

    /// F4: the refresh period must be at most one third of the room TTL, so a
    /// live room is always refreshed well before it can expire; and never
    /// below one second even for a pathologically small TTL.
    #[test]
    fn ttl_refresh_interval_is_at_most_a_third_of_ttl() {
        assert_eq!(ttl_refresh_interval(3_600), Duration::from_secs(1_200));
        assert_eq!(ttl_refresh_interval(90), Duration::from_secs(30));
        assert_eq!(ttl_refresh_interval(3), Duration::from_secs(1));
        assert_eq!(ttl_refresh_interval(0), Duration::from_secs(1));
    }

    /// F4: with no Redis installed, the refresh call must be a silent no-op
    /// (never a panic, never an error surfaced to the hot path).
    #[tokio::test]
    async fn disabled_relay_refresh_is_a_silent_noop() {
        let relay = RelayManager::disabled("gomoku:signal");
        let codes = vec![
            RoomCode::new("ABCD").expect("code"),
            RoomCode::new("WXYZ").expect("code"),
        ];
        relay.refresh_rooms(&codes, 60).await;
    }
}
