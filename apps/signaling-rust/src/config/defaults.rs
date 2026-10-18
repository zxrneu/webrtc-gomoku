//! Built-in default values (the lowest precedence layer).
//!
//! Every value here mirrors PRD §5.2 exactly; no magic numbers are allowed to
//! live anywhere else in the crate.

use std::sync::OnceLock;

use rand::distributions::{Alphanumeric, DistString};

use crate::config::{
    AdminConfig, ClusterConfig, Config, CorsConfig, IceConfig, LimitsConfig, LoggingConfig,
    RedisConfig, ServerConfig, SessionConfig, TimeoutsConfig,
};

/// Default bind host.
pub const HOST: &str = "0.0.0.0";
/// Default bind port.
pub const PORT: u16 = 3000;
/// Default static directory (before fallback probing).
pub const PUBLIC_DIR: &str = "public";
/// Default WS ping interval (seconds).
pub const WS_PING_INTERVAL_SECS: u64 = 30;
/// Default WS idle timeout (seconds) — two ping periods, aligned with v1.
pub const WS_IDLE_TIMEOUT_SECS: u64 = 60;
/// Default WS handshake timeout (seconds).
pub const WS_HANDSHAKE_TIMEOUT_SECS: u64 = 10;
/// Default graceful-shutdown drain window (seconds).
pub const SHUTDOWN_DRAIN_SECS: u64 = 15;
/// Default seat grace window (seconds) — mirrors the Node server's `GRACE_SECS`.
pub const SESSION_GRACE_SECS: u64 = 60;
/// Default grace-expiry sweep period (seconds) — mirrors the Node server.
pub const SESSION_SWEEP_INTERVAL_SECS: u64 = 5;
/// Default global connection cap.
pub const MAX_CONNECTIONS: u64 = 100_000;
/// Default per-IP connection cap.
pub const MAX_CONNECTIONS_PER_IP: u32 = 10;
/// Default room cap.
pub const MAX_ROOMS: u32 = 50_000;
/// Default single-message size cap (64 KiB, covers SDP/ICE payloads).
pub const MAX_MESSAGE_BYTES: usize = 65_536;
/// Default per-connection outbound queue capacity.
pub const BROADCAST_QUEUE_CAPACITY: u64 = 256;
/// Whether the cross-node relay is enabled by default.
pub const REDIS_ENABLED: bool = true;
/// Default Redis connection string.
pub const REDIS_URL: &str = "redis://127.0.0.1:6379";
/// Default Redis publisher pool size.
pub const REDIS_POOL_SIZE: u32 = 16;
/// Default Redis key / channel prefix.
pub const REDIS_CHANNEL_PREFIX: &str = "gomoku:signal";
/// Default Redis connect timeout (ms).
pub const REDIS_CONNECT_TIMEOUT_MS: u64 = 5_000;
/// Default room registration TTL (seconds).
pub const ROOM_TTL_SECS: u64 = 3_600;
/// Default log level.
pub const LOG_LEVEL: &str = "info";
/// Default log format.
pub const LOG_FORMAT: &str = "text";
/// Fallback node name when the hostname cannot be resolved.
pub const NODE_FALLBACK: &str = "node";
/// Length of the random suffix appended to the hostname for the default node id.
pub const NODE_SUFFIX_LEN: usize = 8;

/// The default STUN server list (mirrors `packages/web/src/webrtc.ts`).
pub fn default_stun_servers() -> Vec<String> {
    vec![
        "stun:stun.qq.com:3478".to_string(),
        "stun:stun.aliyun.com:3478".to_string(),
        "stun:stun1.l.google.com:19302".to_string(),
        "stun:stun2.l.google.com:19302".to_string(),
    ]
}

/// Process-stable default node id.
///
/// The node id is a *per-process* identity: it must not change while the
/// process is alive (otherwise a hot reload would report a spurious
/// `cluster.node_id` change and cross-node messages would carry a new
/// identity). We therefore memoise the randomly-generated value for the
/// lifetime of the process via a [`OnceLock`]. Distinct processes still get
/// distinct ids.
static DEFAULT_NODE_ID: OnceLock<String> = OnceLock::new();

/// Generate (once per process) a default node id: `<hostname>-<rand8>`.
///
/// Uses `rand`'s alphanumeric distribution directly (architecture §10 lists
/// `rand` as the node-id generator) so that `config` stays a dependency-free
/// leaf module.
pub fn default_node_id() -> String {
    DEFAULT_NODE_ID
        .get_or_init(|| {
            let host = std::env::var("HOSTNAME")
                .ok()
                .filter(|h| !h.trim().is_empty())
                .unwrap_or_else(|| NODE_FALLBACK.to_string());
            let suffix = Alphanumeric.sample_string(&mut rand::thread_rng(), NODE_SUFFIX_LEN);
            format!("{host}-{suffix}")
        })
        .clone()
}

/// Build the built-in default configuration.
pub fn builtin() -> Config {
    Config {
        server: ServerConfig {
            host: HOST.to_string(),
            port: PORT,
            public_dir: PUBLIC_DIR.to_string(),
            allowed_ws_origins: Vec::new(),
            trust_proxy_headers: false,
        },
        timeouts: TimeoutsConfig {
            ws_ping_interval_secs: WS_PING_INTERVAL_SECS,
            ws_idle_timeout_secs: WS_IDLE_TIMEOUT_SECS,
            ws_handshake_timeout_secs: WS_HANDSHAKE_TIMEOUT_SECS,
            shutdown_drain_secs: SHUTDOWN_DRAIN_SECS,
        },
        session: SessionConfig {
            grace_secs: SESSION_GRACE_SECS,
            sweep_interval_secs: SESSION_SWEEP_INTERVAL_SECS,
        },
        limits: LimitsConfig {
            max_connections: MAX_CONNECTIONS,
            max_connections_per_ip: MAX_CONNECTIONS_PER_IP,
            max_rooms: MAX_ROOMS,
            max_message_bytes: MAX_MESSAGE_BYTES,
            broadcast_queue_capacity: BROADCAST_QUEUE_CAPACITY,
        },
        redis: RedisConfig {
            enabled: REDIS_ENABLED,
            url: REDIS_URL.to_string(),
            pool_size: REDIS_POOL_SIZE,
            channel_prefix: REDIS_CHANNEL_PREFIX.to_string(),
            connect_timeout_ms: REDIS_CONNECT_TIMEOUT_MS,
            room_ttl_secs: ROOM_TTL_SECS,
        },
        cluster: ClusterConfig {
            node_id: default_node_id(),
            nodes: Vec::new(),
        },
        cors: CorsConfig {
            origins: Vec::new(),
        },
        logging: LoggingConfig {
            level: LOG_LEVEL.to_string(),
            format: LOG_FORMAT.to_string(),
        },
        ice: IceConfig {
            stun_servers: default_stun_servers(),
            turn_url: String::new(),
            turn_username: String::new(),
            turn_credential: String::new(),
            turn_credential_exposed: true,
        },
        admin: AdminConfig {
            token: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_matches_prd_defaults() {
        let c = builtin();
        assert_eq!(c.server.host, "0.0.0.0");
        assert_eq!(c.server.port, 3000);
        assert_eq!(c.server.public_dir, "public");
        assert_eq!(c.timeouts.ws_ping_interval_secs, 30);
        assert_eq!(c.timeouts.ws_idle_timeout_secs, 60);
        assert_eq!(c.timeouts.ws_handshake_timeout_secs, 10);
        assert_eq!(c.timeouts.shutdown_drain_secs, 15);
        assert_eq!(c.session.grace_secs, 60);
        assert_eq!(c.session.sweep_interval_secs, 5);
        assert_eq!(c.limits.max_connections, 100_000);
        assert_eq!(c.limits.max_connections_per_ip, 10);
        assert_eq!(c.limits.max_rooms, 50_000);
        assert_eq!(c.limits.max_message_bytes, 65_536);
        assert_eq!(c.limits.broadcast_queue_capacity, 256);
        assert_eq!(c.redis.url, "redis://127.0.0.1:6379");
        assert_eq!(c.redis.pool_size, 16);
        assert_eq!(c.redis.channel_prefix, "gomoku:signal");
        assert_eq!(c.redis.connect_timeout_ms, 5_000);
        assert_eq!(c.redis.room_ttl_secs, 3_600);
        assert_eq!(c.logging.level, "info");
        assert_eq!(c.logging.format, "text");
        assert_eq!(c.ice.stun_servers.len(), 4);
        assert!(c.ice.turn_credential_exposed);
        assert!(c.admin.token.is_empty());
        assert!(c.cors.origins.is_empty());
        assert!(!c.server.trust_proxy_headers);
        assert!(c.server.allowed_ws_origins.is_empty());
    }

    #[test]
    fn builtin_is_valid() {
        assert!(builtin().validate().is_ok());
    }

    #[test]
    fn default_node_id_has_suffix() {
        let id = default_node_id();
        assert!(id.contains('-'));
        assert!(id.len() > 8);
    }

    #[test]
    fn default_node_id_is_stable_within_process() {
        // A reload rebuilds the config from builtin defaults; the node id must
        // not drift, otherwise every reload reports a spurious change.
        assert_eq!(default_node_id(), default_node_id());
        assert_eq!(builtin().cluster.node_id, builtin().cluster.node_id);
    }
}
