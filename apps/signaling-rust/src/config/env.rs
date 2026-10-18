//! Environment-variable overlay (the highest precedence layer).
//!
//! Environment variables are named `GOMOKU_` + the upper-cased key. Arrays are
//! comma-separated. An injectable [`EnvSource`] keeps the module unit-testable
//! without mutating process-global state (AGENTS.md DIP).

use std::collections::HashMap;

use crate::config::{Config, ConfigError};

/// Path of the configuration file itself.
pub const KEY_CONFIG_FILE: &str = "GOMOKU_CONFIG_FILE";

/// `[server]`
pub const HOST: &str = "GOMOKU_HOST";
/// `[server]`
pub const PORT: &str = "GOMOKU_PORT";
/// `[server]`
pub const PUBLIC_DIR: &str = "GOMOKU_PUBLIC_DIR";
/// `[server]`
pub const ALLOWED_WS_ORIGINS: &str = "GOMOKU_ALLOWED_WS_ORIGINS";
/// `[server]`
pub const TRUST_PROXY_HEADERS: &str = "GOMOKU_TRUST_PROXY_HEADERS";

/// `[timeouts]`
pub const WS_PING_INTERVAL: &str = "GOMOKU_WS_PING_INTERVAL";
/// `[timeouts]`
pub const WS_IDLE_TIMEOUT: &str = "GOMOKU_WS_IDLE_TIMEOUT";
/// `[timeouts]`
pub const WS_HANDSHAKE_TIMEOUT: &str = "GOMOKU_WS_HANDSHAKE_TIMEOUT";
/// `[timeouts]`
pub const SHUTDOWN_DRAIN: &str = "GOMOKU_SHUTDOWN_DRAIN";

/// `[session]`
pub const SESSION_GRACE: &str = "GOMOKU_SESSION_GRACE";
/// `[session]`
pub const SESSION_SWEEP_INTERVAL: &str = "GOMOKU_SESSION_SWEEP_INTERVAL";

/// `[limits]`
pub const MAX_CONNECTIONS: &str = "GOMOKU_MAX_CONNECTIONS";
/// `[limits]`
pub const MAX_CONNECTIONS_PER_IP: &str = "GOMOKU_MAX_CONNECTIONS_PER_IP";
/// `[limits]`
pub const MAX_ROOMS: &str = "GOMOKU_MAX_ROOMS";
/// `[limits]`
pub const MAX_MESSAGE_BYTES: &str = "GOMOKU_MAX_MESSAGE_BYTES";
/// `[limits]`
pub const BROADCAST_QUEUE_CAPACITY: &str = "GOMOKU_BROADCAST_QUEUE_CAPACITY";

/// `[redis]`
pub const REDIS_ENABLED: &str = "GOMOKU_REDIS_ENABLED";
/// `[redis]`
pub const REDIS_URL: &str = "GOMOKU_REDIS_URL";
/// `[redis]`
pub const REDIS_POOL_SIZE: &str = "GOMOKU_REDIS_POOL_SIZE";
/// `[redis]`
pub const REDIS_CHANNEL_PREFIX: &str = "GOMOKU_REDIS_CHANNEL_PREFIX";
/// `[redis]`
pub const REDIS_CONNECT_TIMEOUT_MS: &str = "GOMOKU_REDIS_CONNECT_TIMEOUT_MS";
/// `[redis]`
pub const ROOM_TTL: &str = "GOMOKU_ROOM_TTL";

/// `[cluster]`
pub const NODE_ID: &str = "GOMOKU_NODE_ID";
/// `[cluster]`
pub const CLUSTER_NODES: &str = "GOMOKU_CLUSTER_NODES";

/// `[cors]`
pub const CORS_ORIGINS: &str = "GOMOKU_CORS_ORIGINS";

/// `[logging]`
pub const LOG_LEVEL: &str = "GOMOKU_LOG_LEVEL";
/// `[logging]`
pub const LOG_FORMAT: &str = "GOMOKU_LOG_FORMAT";

/// `[ice]`
pub const STUN_SERVERS: &str = "GOMOKU_STUN_SERVERS";
/// `[ice]`
pub const TURN_URL: &str = "GOMOKU_TURN_URL";
/// `[ice]`
pub const TURN_USER: &str = "GOMOKU_TURN_USER";
/// `[ice]`
pub const TURN_CREDENTIAL: &str = "GOMOKU_TURN_CREDENTIAL";
/// `[ice]`
pub const TURN_CREDENTIAL_EXPOSED: &str = "GOMOKU_TURN_CREDENTIAL_EXPOSED";

/// `[admin]`
pub const ADMIN_TOKEN: &str = "GOMOKU_ADMIN_TOKEN";

/// Abstraction over the environment so tests can inject a fake.
pub trait EnvSource {
    /// Return the value of `key`, or `None` when unset.
    fn get(&self, key: &str) -> Option<String>;
}

/// The real process environment.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// A fixed key/value environment for tests.
#[derive(Debug, Default, Clone)]
pub struct MapEnv {
    map: HashMap<String, String>,
}

impl MapEnv {
    /// Build from `(key, value)` pairs.
    pub fn new(pairs: &[(&str, &str)]) -> Self {
        Self {
            map: pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        }
    }

    /// Insert a single pair, returning `self` for chaining.
    pub fn with(mut self, key: &str, value: &str) -> Self {
        self.map.insert(key.to_string(), value.to_string());
        self
    }
}

impl EnvSource for MapEnv {
    fn get(&self, key: &str) -> Option<String> {
        self.map.get(key).cloned()
    }
}

/// Apply all present `GOMOKU_*` overrides onto `cfg`.
pub fn apply(cfg: &mut Config, env: &dyn EnvSource) -> Result<(), ConfigError> {
    if let Some(v) = str_of(env, HOST) {
        cfg.server.host = v;
    }
    if let Some(v) = u16_of(env, PORT)? {
        cfg.server.port = v;
    }
    if let Some(v) = str_of(env, PUBLIC_DIR) {
        cfg.server.public_dir = v;
    }
    if let Some(v) = list_of(env, ALLOWED_WS_ORIGINS) {
        cfg.server.allowed_ws_origins = v;
    }
    if let Some(v) = bool_of(env, TRUST_PROXY_HEADERS)? {
        cfg.server.trust_proxy_headers = v;
    }

    if let Some(v) = u64_of(env, WS_PING_INTERVAL)? {
        cfg.timeouts.ws_ping_interval_secs = v;
    }
    if let Some(v) = u64_of(env, WS_IDLE_TIMEOUT)? {
        cfg.timeouts.ws_idle_timeout_secs = v;
    }
    if let Some(v) = u64_of(env, WS_HANDSHAKE_TIMEOUT)? {
        cfg.timeouts.ws_handshake_timeout_secs = v;
    }
    if let Some(v) = u64_of(env, SHUTDOWN_DRAIN)? {
        cfg.timeouts.shutdown_drain_secs = v;
    }

    if let Some(v) = u64_of(env, SESSION_GRACE)? {
        cfg.session.grace_secs = v;
    }
    if let Some(v) = u64_of(env, SESSION_SWEEP_INTERVAL)? {
        cfg.session.sweep_interval_secs = v;
    }

    if let Some(v) = u64_of(env, MAX_CONNECTIONS)? {
        cfg.limits.max_connections = v;
    }
    if let Some(v) = u32_of(env, MAX_CONNECTIONS_PER_IP)? {
        cfg.limits.max_connections_per_ip = v;
    }
    if let Some(v) = u32_of(env, MAX_ROOMS)? {
        cfg.limits.max_rooms = v;
    }
    if let Some(v) = usize_of(env, MAX_MESSAGE_BYTES)? {
        cfg.limits.max_message_bytes = v;
    }
    if let Some(v) = u64_of(env, BROADCAST_QUEUE_CAPACITY)? {
        cfg.limits.broadcast_queue_capacity = v;
    }

    if let Some(v) = bool_of(env, REDIS_ENABLED)? {
        cfg.redis.enabled = v;
    }
    // Unlike every other string key, an *explicitly empty* `GOMOKU_REDIS_URL` is
    // meaningful — it disables the relay — so this one must not filter empties.
    if let Some(v) = env.get(REDIS_URL) {
        cfg.redis.url = v.trim().to_string();
    }
    if let Some(v) = u32_of(env, REDIS_POOL_SIZE)? {
        cfg.redis.pool_size = v;
    }
    if let Some(v) = str_of(env, REDIS_CHANNEL_PREFIX) {
        cfg.redis.channel_prefix = v;
    }
    if let Some(v) = u64_of(env, REDIS_CONNECT_TIMEOUT_MS)? {
        cfg.redis.connect_timeout_ms = v;
    }
    if let Some(v) = u64_of(env, ROOM_TTL)? {
        cfg.redis.room_ttl_secs = v;
    }

    if let Some(v) = str_of(env, NODE_ID) {
        cfg.cluster.node_id = v;
    }
    if let Some(v) = list_of(env, CLUSTER_NODES) {
        cfg.cluster.nodes = v;
    }

    if let Some(v) = list_of(env, CORS_ORIGINS) {
        cfg.cors.origins = v;
    }

    if let Some(v) = str_of(env, LOG_LEVEL) {
        cfg.logging.level = v;
    }
    if let Some(v) = str_of(env, LOG_FORMAT) {
        cfg.logging.format = v;
    }

    if let Some(v) = list_of(env, STUN_SERVERS) {
        cfg.ice.stun_servers = v;
    }
    if let Some(v) = str_of(env, TURN_URL) {
        cfg.ice.turn_url = v;
    }
    if let Some(v) = str_of(env, TURN_USER) {
        cfg.ice.turn_username = v;
    }
    if let Some(v) = str_of(env, TURN_CREDENTIAL) {
        cfg.ice.turn_credential = v;
    }
    if let Some(v) = bool_of(env, TURN_CREDENTIAL_EXPOSED)? {
        cfg.ice.turn_credential_exposed = v;
    }

    if let Some(v) = str_of(env, ADMIN_TOKEN) {
        cfg.admin.token = v;
    }

    Ok(())
}

fn raw(env: &dyn EnvSource, key: &str) -> Option<String> {
    env.get(key).filter(|v| !v.is_empty())
}

fn str_of(env: &dyn EnvSource, key: &str) -> Option<String> {
    raw(env, key)
}

fn list_of(env: &dyn EnvSource, key: &str) -> Option<Vec<String>> {
    env.get(key).map(|v| {
        v.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

fn parse<T: std::str::FromStr>(env: &dyn EnvSource, key: &str) -> Result<Option<T>, ConfigError>
where
    T::Err: std::fmt::Display,
{
    match raw(env, key) {
        None => Ok(None),
        Some(v) => v
            .trim()
            .parse::<T>()
            .map(Some)
            .map_err(|e| ConfigError::Env {
                var: key.to_string(),
                reason: e.to_string(),
            }),
    }
}

fn u64_of(env: &dyn EnvSource, key: &str) -> Result<Option<u64>, ConfigError> {
    parse(env, key)
}

fn u32_of(env: &dyn EnvSource, key: &str) -> Result<Option<u32>, ConfigError> {
    parse(env, key)
}

fn u16_of(env: &dyn EnvSource, key: &str) -> Result<Option<u16>, ConfigError> {
    parse(env, key)
}

fn usize_of(env: &dyn EnvSource, key: &str) -> Result<Option<usize>, ConfigError> {
    parse(env, key)
}

fn bool_of(env: &dyn EnvSource, key: &str) -> Result<Option<bool>, ConfigError> {
    match raw(env, key) {
        None => Ok(None),
        Some(v) => match v.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Ok(Some(true)),
            "false" | "0" | "no" | "off" => Ok(Some(false)),
            other => Err(ConfigError::Env {
                var: key.to_string(),
                reason: format!("非法布尔值 {other}"),
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_overrides_scalars_and_lists() {
        let env = MapEnv::new(&[
            (PORT, "9090"),
            (LOG_LEVEL, "debug"),
            (CORS_ORIGINS, "https://a.example, https://b.example"),
            (BROADCAST_QUEUE_CAPACITY, "512"),
            (TRUST_PROXY_HEADERS, "true"),
            (TURN_CREDENTIAL_EXPOSED, "false"),
            (ALLOWED_WS_ORIGINS, "https://ws.example"),
        ]);
        let mut cfg = Config::default();
        apply(&mut cfg, &env).expect("apply");
        assert_eq!(cfg.server.port, 9090);
        assert_eq!(cfg.logging.level, "debug");
        assert_eq!(
            cfg.cors.origins,
            vec!["https://a.example", "https://b.example"]
        );
        assert_eq!(cfg.limits.broadcast_queue_capacity, 512);
        assert!(cfg.server.trust_proxy_headers);
        assert!(!cfg.ice.turn_credential_exposed);
        assert_eq!(cfg.server.allowed_ws_origins, vec!["https://ws.example"]);
    }

    #[test]
    fn env_overrides_session_grace_and_sweep() {
        let env = MapEnv::new(&[(SESSION_GRACE, "15"), (SESSION_SWEEP_INTERVAL, "1")]);
        let mut cfg = Config::default();
        apply(&mut cfg, &env).expect("apply");
        assert_eq!(cfg.session.grace_secs, 15);
        assert_eq!(cfg.session.sweep_interval_secs, 1);
    }

    #[test]
    fn env_invalid_number_reports_error() {
        let env = MapEnv::new(&[(PORT, "not-a-port")]);
        let mut cfg = Config::default();
        let err = apply(&mut cfg, &env).unwrap_err();
        assert!(matches!(err, ConfigError::Env { ref var, .. } if var == PORT));
    }

    #[test]
    fn env_invalid_bool_reports_error() {
        let env = MapEnv::new(&[(TRUST_PROXY_HEADERS, "maybe")]);
        let mut cfg = Config::default();
        assert!(apply(&mut cfg, &env).is_err());
    }

    #[test]
    fn redis_enabled_can_be_switched_off() {
        let env = MapEnv::new(&[(REDIS_ENABLED, "false")]);
        let mut cfg = Config::default();
        apply(&mut cfg, &env).expect("apply");
        assert!(!cfg.redis.enabled);
        assert!(!cfg.redis.is_active());
    }

    #[test]
    fn empty_redis_url_disables_relay() {
        // Unlike every other string key, an explicitly empty value is meaningful.
        let env = MapEnv::new(&[(REDIS_URL, "")]);
        let mut cfg = Config::default();
        apply(&mut cfg, &env).expect("apply");
        assert_eq!(cfg.redis.url, "");
        assert!(!cfg.redis.is_active());
    }

    #[test]
    fn redis_url_is_trimmed() {
        let env = MapEnv::new(&[(REDIS_URL, "  redis://cache:6379  ")]);
        let mut cfg = Config::default();
        apply(&mut cfg, &env).expect("apply");
        assert_eq!(cfg.redis.url, "redis://cache:6379");
    }

    #[test]
    fn empty_env_changes_nothing() {
        let env = MapEnv::default();
        let mut cfg = Config::default();
        let before = cfg.clone();
        apply(&mut cfg, &env).expect("apply");
        assert_eq!(before, cfg);
    }

    #[test]
    fn empty_string_is_ignored() {
        let env = MapEnv::new(&[(HOST, "")]);
        let mut cfg = Config::default();
        apply(&mut cfg, &env).expect("apply");
        assert_eq!(cfg.server.host, "0.0.0.0");
    }
}
