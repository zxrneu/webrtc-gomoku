//! Configuration module.
//!
//! Three-layer merge (later wins): built-in defaults < `config.toml` < environment.
//! Provides schema validation (fail-fast), secret redaction, and a lock-free
//! `ArcSwap` snapshot for the hot path.

pub mod defaults;
pub mod env;
pub mod file;
pub mod reload;

use std::path::Path;
use std::sync::Arc;

use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use env::{EnvSource, MapEnv, ProcessEnv};
pub use file::PartialConfig;
pub use reload::{compute_reload_report, reload, ReloadReport};

/// Domain error for configuration loading / validation.
#[derive(Error, Debug)]
pub enum ConfigError {
    /// A specific configuration key failed validation.
    #[error("配置项 {key} 非法: {reason}")]
    Invalid { key: String, reason: String },
    /// The configuration file could not be read.
    #[error("配置文件读取失败: {0}")]
    Io(#[from] std::io::Error),
    /// The configuration file could not be parsed as TOML.
    #[error("配置文件解析失败: {0}")]
    Toml(#[from] toml::de::Error),
    /// An environment variable held an unparseable value.
    #[error("环境变量 {var} 非法: {reason}")]
    Env { var: String, reason: String },
}

/// `[server]` — listening / static hosting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Bind address.
    pub host: String,
    /// Bind port.
    pub port: u16,
    /// Static assets directory (falls back to `packages/web/dist`, `dist`, `public`).
    pub public_dir: String,
    /// Optional WS `Origin` allow-list. Empty = do not validate Origin (v1 behaviour).
    pub allowed_ws_origins: Vec<String>,
    /// Whether per-IP rate limiting trusts `X-Forwarded-For` (default `false`).
    pub trust_proxy_headers: bool,
}

/// `[timeouts]` — protocol timeouts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeoutsConfig {
    /// WS ping period.
    pub ws_ping_interval_secs: u64,
    /// No-pong idle window before a connection is considered dead.
    pub ws_idle_timeout_secs: u64,
    /// WS handshake timeout.
    pub ws_handshake_timeout_secs: u64,
    /// Graceful-shutdown drain window.
    pub shutdown_drain_secs: u64,
}

/// `[limits]` — concurrency limits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitsConfig {
    /// Global WS connection cap.
    pub max_connections: u64,
    /// Per-IP connection cap.
    pub max_connections_per_ip: u32,
    /// Room count cap.
    pub max_rooms: u32,
    /// Single message size cap (bytes).
    pub max_message_bytes: usize,
    /// Per-connection outbound queue capacity (back-pressure bound).
    pub broadcast_queue_capacity: u64,
}

/// `[redis]` — cross-node relay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisConfig {
    /// Master switch for the cross-node relay (default `true`).
    ///
    /// Set to `false` for a single-node deployment: the background connector is
    /// never spawned, so there is no reconnect churn and no `warn` log every
    /// 30s. The node keeps serving local rooms exactly as it does when Redis is
    /// merely unreachable — this switch only makes that state intentional and
    /// quiet. Changing it requires a restart.
    pub enabled: bool,
    /// Connection string (may embed credentials).
    ///
    /// An empty value also disables the relay (equivalent to `enabled = false`),
    /// which makes `GOMOKU_REDIS_URL=""` a convenient way to opt out.
    pub url: String,
    /// Publisher connection pool size.
    pub pool_size: u32,
    /// pub/sub channel / key prefix.
    pub channel_prefix: String,
    /// Connect timeout (ms).
    pub connect_timeout_ms: u64,
    /// Room registration TTL (seconds).
    pub room_ttl_secs: u64,
}

impl RedisConfig {
    /// Whether the cross-node relay should actually be started.
    ///
    /// This is the single source of truth for "is Redis active": both the
    /// `enabled` switch and a non-empty `url` are required. Callers must use
    /// this rather than inspecting `enabled` or `url` individually.
    pub fn is_active(&self) -> bool {
        self.enabled && !self.url.trim().is_empty()
    }
}

/// `[cluster]` — node identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClusterConfig {
    /// Node identifier (appears in logs and cross-node messages).
    pub node_id: String,
    /// Reserved node list (management surface / future direct dial).
    pub nodes: Vec<String>,
}

/// `[cors]` — HTTP CORS.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorsConfig {
    /// Allowed origins. Empty = same-origin only (no CORS headers emitted).
    pub origins: Vec<String>,
}

/// `[logging]` — structured logging.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoggingConfig {
    /// `trace` / `debug` / `info` / `warn` / `error`.
    pub level: String,
    /// `text` / `json`.
    pub format: String,
}

/// `[ice]` — STUN/TURN handed to clients via `GET /config`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceConfig {
    /// STUN server list.
    pub stun_servers: Vec<String>,
    /// TURN URL. Empty = no TURN section is emitted.
    pub turn_url: String,
    /// TURN username.
    pub turn_username: String,
    /// TURN credential (redacted in logs and `/admin/config`).
    pub turn_credential: String,
    /// Whether the TURN credential is exposed via `GET /config` (default `true`).
    pub turn_credential_exposed: bool,
}

/// `[admin]` — management API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminConfig {
    /// Bearer token. Empty = the whole management surface is disabled (404).
    pub token: String,
}

/// Fully-resolved, validated configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// `[server]`
    pub server: ServerConfig,
    /// `[timeouts]`
    pub timeouts: TimeoutsConfig,
    /// `[limits]`
    pub limits: LimitsConfig,
    /// `[redis]`
    pub redis: RedisConfig,
    /// `[cluster]`
    pub cluster: ClusterConfig,
    /// `[cors]`
    pub cors: CorsConfig,
    /// `[logging]`
    pub logging: LoggingConfig,
    /// `[ice]`
    pub ice: IceConfig,
    /// `[admin]`
    pub admin: AdminConfig,
}

impl Default for Config {
    fn default() -> Self {
        defaults::builtin()
    }
}

/// The redaction marker used for secrets.
pub const REDACTED: &str = "***";

impl Config {
    /// Load configuration using the real process environment.
    pub fn load() -> Result<Arc<ConfigSnapshot>, ConfigError> {
        Self::load_with(&ProcessEnv)
    }

    /// Load configuration from `<GOMOKU_CONFIG_FILE|config.toml>` plus the
    /// supplied environment source, validate it, and wrap it in a snapshot.
    pub fn load_with(env: &dyn EnvSource) -> Result<Arc<ConfigSnapshot>, ConfigError> {
        let path = env
            .get(env::KEY_CONFIG_FILE)
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| file::DEFAULT_CONFIG_PATH.to_string());
        let cfg = Self::assemble(Path::new(&path), env)?;
        Ok(Arc::new(ConfigSnapshot::new(cfg)))
    }

    /// Build a validated [`Config`] from the three layers.
    pub fn assemble(path: &Path, env: &dyn EnvSource) -> Result<Config, ConfigError> {
        let mut cfg = Config::default();
        if path.exists() {
            let partial = file::read_partial(path)?;
            cfg.apply_partial(&partial);
        }
        env::apply(&mut cfg, env)?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Overlay a partial (TOML) configuration onto this one.
    pub fn apply_partial(&mut self, p: &PartialConfig) {
        p.apply_to(self);
    }

    /// Fail-fast schema validation.
    pub fn validate(&self) -> Result<(), ConfigError> {
        validate::validate(self)
    }

    /// Clone with all secrets masked (`turn_credential`, `admin_token`,
    /// embedded `redis_url` password).
    pub fn redacted(&self) -> Config {
        let mut c = self.clone();
        if !c.admin.token.is_empty() {
            c.admin.token = REDACTED.to_string();
        }
        if !c.ice.turn_credential.is_empty() {
            c.ice.turn_credential = REDACTED.to_string();
        }
        c.redis.url = mask_redis_password(&c.redis.url);
        c
    }

    /// Redacted view as a JSON value (for `/admin/config`).
    pub fn redacted_json(&self) -> serde_json::Value {
        serde_json::to_value(self.redacted()).unwrap_or(serde_json::Value::Null)
    }
}

/// Mask the password embedded in a `redis://` / `rediss://` URL.
pub fn mask_redis_password(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (s, r),
        None => return url.to_string(),
    };
    // rest = [user[:pass]@]host[:port][/db]
    let (creds, host) = match rest.rsplit_once('@') {
        Some((c, h)) => (Some(c), h),
        None => (None, rest),
    };
    match creds {
        None => url.to_string(),
        Some(creds) => {
            let user = creds.split(':').next().unwrap_or("");
            if creds.contains(':') {
                format!("{scheme}://{user}:{REDACTED}@{host}")
            } else {
                // user without password — keep as-is
                format!("{scheme}://{creds}@{host}")
            }
        }
    }
}

/// Lock-free configuration snapshot.
pub struct ConfigSnapshot {
    inner: ArcSwap<Config>,
}

impl ConfigSnapshot {
    /// Wrap an already-validated config.
    pub fn new(cfg: Config) -> Self {
        Self {
            inner: ArcSwap::from_pointee(cfg),
        }
    }

    /// Load (defaults < file < env) and wrap in a snapshot.
    pub fn load() -> Result<Arc<Self>, ConfigError> {
        Config::load()
    }

    /// Atomically read the current configuration (lock-free).
    pub fn snapshot(&self) -> Arc<Config> {
        self.inner.load_full()
    }

    /// Atomically replace the current configuration.
    pub fn store(&self, cfg: Config) {
        self.inner.store(Arc::new(cfg));
    }
}

/// Validation helpers, kept private to the module.
mod validate {
    use super::{Config, ConfigError};

    fn invalid(key: &str, reason: &str) -> ConfigError {
        ConfigError::Invalid {
            key: key.to_string(),
            reason: reason.to_string(),
        }
    }

    /// Validate the fully-merged configuration.
    pub fn validate(c: &Config) -> Result<(), ConfigError> {
        if c.server.host.trim().is_empty() {
            return Err(invalid("server.host", "不能为空"));
        }
        if c.server.port == 0 {
            return Err(invalid("server.port", "端口需在 1..=65535"));
        }
        check_nonzero(
            c.timeouts.ws_ping_interval_secs,
            "timeouts.ws_ping_interval_secs",
        )?;
        check_nonzero(
            c.timeouts.ws_idle_timeout_secs,
            "timeouts.ws_idle_timeout_secs",
        )?;
        check_nonzero(
            c.timeouts.ws_handshake_timeout_secs,
            "timeouts.ws_handshake_timeout_secs",
        )?;
        check_nonzero(
            c.timeouts.shutdown_drain_secs,
            "timeouts.shutdown_drain_secs",
        )?;

        check_nonzero(c.limits.max_connections, "limits.max_connections")?;
        check_nonzero(
            c.limits.max_connections_per_ip as u64,
            "limits.max_connections_per_ip",
        )?;
        check_nonzero(c.limits.max_rooms as u64, "limits.max_rooms")?;
        check_nonzero(
            c.limits.max_message_bytes as u64,
            "limits.max_message_bytes",
        )?;
        check_nonzero(
            c.limits.broadcast_queue_capacity,
            "limits.broadcast_queue_capacity",
        )?;

        if c.limits.max_connections_per_ip as u64 > c.limits.max_connections {
            return Err(invalid(
                "limits.max_connections_per_ip",
                "不能大于 limits.max_connections",
            ));
        }

        // An empty `redis.url` means "cross-node relay disabled" and is allowed;
        // a non-empty one must be a well-formed Redis URL.
        let redis_url = c.redis.url.trim();
        if !redis_url.is_empty() && !is_redis_url(redis_url) {
            return Err(invalid(
                "redis.url",
                "需以 redis:// 或 rediss:// 开头（留空表示禁用 Redis）",
            ));
        }
        check_nonzero(c.redis.pool_size as u64, "redis.pool_size")?;
        check_nonzero(c.redis.connect_timeout_ms, "redis.connect_timeout_ms")?;
        check_nonzero(c.redis.room_ttl_secs, "redis.room_ttl_secs")?;
        if c.redis.channel_prefix.trim().is_empty() {
            return Err(invalid("redis.channel_prefix", "不能为空"));
        }

        if c.cluster.node_id.trim().is_empty() {
            return Err(invalid("cluster.node_id", "不能为空"));
        }

        if !matches!(
            c.logging.level.as_str(),
            "trace" | "debug" | "info" | "warn" | "error"
        ) {
            return Err(invalid(
                "logging.level",
                "需为 trace/debug/info/warn/error 之一",
            ));
        }
        if !matches!(c.logging.format.as_str(), "text" | "json") {
            return Err(invalid("logging.format", "需为 text 或 json"));
        }

        let turn_url = &c.ice.turn_url;
        if !(turn_url.is_empty() || turn_url.starts_with("turn:") || turn_url.starts_with("turns:"))
        {
            return Err(invalid("ice.turn_url", "需以 turn: 或 turns: 开头"));
        }

        Ok(())
    }

    fn check_nonzero(value: u64, key: &str) -> Result<(), ConfigError> {
        if value == 0 {
            Err(invalid(key, "需大于 0"))
        } else {
            Ok(())
        }
    }

    fn is_redis_url(url: &str) -> bool {
        url.starts_with("redis://") || url.starts_with("rediss://")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_redis_password_hides_secret() {
        assert_eq!(
            mask_redis_password("redis://user:secret@127.0.0.1:6379"),
            "redis://user:***@127.0.0.1:6379"
        );
        assert_eq!(
            mask_redis_password("redis://127.0.0.1:6379"),
            "redis://127.0.0.1:6379"
        );
        assert_eq!(
            mask_redis_password("rediss://:pw@host:6380/0"),
            "rediss://:***@host:6380/0"
        );
    }

    #[test]
    fn redacted_masks_secrets() {
        let mut c = Config::default();
        c.admin.token = "topsecret".into();
        c.ice.turn_credential = "turnpw".into();
        c.redis.url = "redis://u:p@h:6379".into();
        let r = c.redacted();
        assert_eq!(r.admin.token, REDACTED);
        assert_eq!(r.ice.turn_credential, REDACTED);
        assert_eq!(r.redis.url, "redis://u:***@h:6379");
        // original untouched
        assert_eq!(c.admin.token, "topsecret");
    }

    #[test]
    fn validate_rejects_zero_port() {
        let mut c = Config::default();
        c.server.port = 0;
        assert!(matches!(
            c.validate(),
            Err(ConfigError::Invalid { ref key, .. }) if key == "server.port"
        ));
    }

    #[test]
    fn validate_rejects_bad_redis_url() {
        let mut c = Config::default();
        c.redis.url = "http://localhost".into();
        assert!(matches!(
            c.validate(),
            Err(ConfigError::Invalid { ref key, .. }) if key == "redis.url"
        ));
    }

    #[test]
    fn redis_is_active_requires_both_switch_and_url() {
        let mut c = Config::default();
        assert!(c.redis.is_active(), "默认配置应启用跨节点中转");

        c.redis.enabled = false;
        assert!(!c.redis.is_active(), "enabled=false 应禁用");

        c.redis.enabled = true;
        c.redis.url = String::new();
        assert!(!c.redis.is_active(), "空 url 应禁用");

        c.redis.url = "   ".into();
        assert!(!c.redis.is_active(), "纯空白 url 应禁用");
    }

    #[test]
    fn validate_allows_empty_redis_url_as_disabled() {
        let mut c = Config::default();
        c.redis.url = String::new();
        assert!(
            c.validate().is_ok(),
            "空 redis.url 表示禁用 Redis，应通过校验"
        );
    }

    #[test]
    fn validate_rejects_zero_timeout() {
        let mut c = Config::default();
        c.timeouts.ws_idle_timeout_secs = 0;
        assert!(matches!(
            c.validate(),
            Err(ConfigError::Invalid { ref key, .. }) if key == "timeouts.ws_idle_timeout_secs"
        ));
    }
}
