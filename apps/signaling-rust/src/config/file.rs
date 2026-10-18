//! TOML deserialization into an all-`Option` partial structure, plus overlay.

use std::path::Path;

use serde::Deserialize;

use crate::config::{
    AdminConfig, ClusterConfig, Config, ConfigError, CorsConfig, IceConfig, LimitsConfig,
    LoggingConfig, RedisConfig, ServerConfig, SessionConfig, TimeoutsConfig,
};

/// Default configuration file path (relative to the working directory).
pub const DEFAULT_CONFIG_PATH: &str = "config.toml";

/// A TOML document where every key is optional.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialConfig {
    /// `[server]`
    pub server: PartialServer,
    /// `[timeouts]`
    pub timeouts: PartialTimeouts,
    /// `[session]`
    pub session: PartialSession,
    /// `[limits]`
    pub limits: PartialLimits,
    /// `[redis]`
    pub redis: PartialRedis,
    /// `[cluster]`
    pub cluster: PartialCluster,
    /// `[cors]`
    pub cors: PartialCors,
    /// `[logging]`
    pub logging: PartialLogging,
    /// `[ice]`
    pub ice: PartialIce,
    /// `[admin]`
    pub admin: PartialAdmin,
}

/// `[server]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialServer {
    /// See [`ServerConfig::host`].
    pub host: Option<String>,
    /// See [`ServerConfig::port`].
    pub port: Option<u16>,
    /// See [`ServerConfig::public_dir`].
    pub public_dir: Option<String>,
    /// See [`ServerConfig::allowed_ws_origins`].
    pub allowed_ws_origins: Option<Vec<String>>,
    /// See [`ServerConfig::trust_proxy_headers`].
    pub trust_proxy_headers: Option<bool>,
}

/// `[timeouts]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialTimeouts {
    /// See [`TimeoutsConfig::ws_ping_interval_secs`].
    pub ws_ping_interval_secs: Option<u64>,
    /// See [`TimeoutsConfig::ws_idle_timeout_secs`].
    pub ws_idle_timeout_secs: Option<u64>,
    /// See [`TimeoutsConfig::ws_handshake_timeout_secs`].
    pub ws_handshake_timeout_secs: Option<u64>,
    /// See [`TimeoutsConfig::shutdown_drain_secs`].
    pub shutdown_drain_secs: Option<u64>,
}

/// `[session]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialSession {
    /// See [`SessionConfig::grace_secs`].
    pub grace_secs: Option<u64>,
    /// See [`SessionConfig::sweep_interval_secs`].
    pub sweep_interval_secs: Option<u64>,
}

/// `[limits]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialLimits {    /// See [`LimitsConfig::max_connections`].
    pub max_connections: Option<u64>,
    /// See [`LimitsConfig::max_connections_per_ip`].
    pub max_connections_per_ip: Option<u32>,
    /// See [`LimitsConfig::max_rooms`].
    pub max_rooms: Option<u32>,
    /// See [`LimitsConfig::max_message_bytes`].
    pub max_message_bytes: Option<usize>,
    /// See [`LimitsConfig::broadcast_queue_capacity`].
    pub broadcast_queue_capacity: Option<u64>,
}

/// `[redis]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialRedis {
    /// See [`RedisConfig::enabled`].
    pub enabled: Option<bool>,
    /// See [`RedisConfig::url`].
    pub url: Option<String>,
    /// See [`RedisConfig::pool_size`].
    pub pool_size: Option<u32>,
    /// See [`RedisConfig::channel_prefix`].
    pub channel_prefix: Option<String>,
    /// See [`RedisConfig::connect_timeout_ms`].
    pub connect_timeout_ms: Option<u64>,
    /// See [`RedisConfig::room_ttl_secs`].
    pub room_ttl_secs: Option<u64>,
}

/// `[cluster]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialCluster {
    /// See [`ClusterConfig::node_id`].
    pub node_id: Option<String>,
    /// See [`ClusterConfig::nodes`].
    pub nodes: Option<Vec<String>>,
}

/// `[cors]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialCors {
    /// See [`CorsConfig::origins`].
    pub origins: Option<Vec<String>>,
}

/// `[logging]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialLogging {
    /// See [`LoggingConfig::level`].
    pub level: Option<String>,
    /// See [`LoggingConfig::format`].
    pub format: Option<String>,
}

/// `[ice]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialIce {
    /// See [`IceConfig::stun_servers`].
    pub stun_servers: Option<Vec<String>>,
    /// See [`IceConfig::turn_url`].
    pub turn_url: Option<String>,
    /// See [`IceConfig::turn_username`].
    pub turn_username: Option<String>,
    /// See [`IceConfig::turn_credential`].
    pub turn_credential: Option<String>,
    /// See [`IceConfig::turn_credential_exposed`].
    pub turn_credential_exposed: Option<bool>,
}

/// `[admin]` partial.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct PartialAdmin {
    /// See [`AdminConfig::token`].
    pub token: Option<String>,
}

impl PartialConfig {
    /// Overlay every present key onto `cfg`.
    pub fn apply_to(&self, cfg: &mut Config) {
        self.server.apply_to(&mut cfg.server);
        self.timeouts.apply_to(&mut cfg.timeouts);
        self.session.apply_to(&mut cfg.session);
        self.limits.apply_to(&mut cfg.limits);
        self.redis.apply_to(&mut cfg.redis);
        self.cluster.apply_to(&mut cfg.cluster);
        self.cors.apply_to(&mut cfg.cors);
        self.logging.apply_to(&mut cfg.logging);
        self.ice.apply_to(&mut cfg.ice);
        self.admin.apply_to(&mut cfg.admin);
    }
}

macro_rules! overlay_field {
    ($src:expr, $dst:expr, $($field:ident),+ $(,)?) => {
        $(
            if let Some(v) = $src.$field.clone() {
                $dst.$field = v;
            }
        )+
    };
}

impl PartialServer {
    fn apply_to(&self, d: &mut ServerConfig) {
        overlay_field!(
            self,
            d,
            host,
            port,
            public_dir,
            allowed_ws_origins,
            trust_proxy_headers
        );
    }
}

impl PartialTimeouts {
    fn apply_to(&self, d: &mut TimeoutsConfig) {
        overlay_field!(
            self,
            d,
            ws_ping_interval_secs,
            ws_idle_timeout_secs,
            ws_handshake_timeout_secs,
            shutdown_drain_secs
        );
    }
}

impl PartialSession {
    fn apply_to(&self, d: &mut SessionConfig) {
        overlay_field!(self, d, grace_secs, sweep_interval_secs);
    }
}

impl PartialLimits {
    fn apply_to(&self, d: &mut LimitsConfig) {        overlay_field!(
            self,
            d,
            max_connections,
            max_connections_per_ip,
            max_rooms,
            max_message_bytes,
            broadcast_queue_capacity
        );
    }
}

impl PartialRedis {
    fn apply_to(&self, d: &mut RedisConfig) {
        overlay_field!(
            self,
            d,
            enabled,
            url,
            pool_size,
            channel_prefix,
            connect_timeout_ms,
            room_ttl_secs
        );
    }
}

impl PartialCluster {
    fn apply_to(&self, d: &mut ClusterConfig) {
        overlay_field!(self, d, node_id, nodes);
    }
}

impl PartialCors {
    fn apply_to(&self, d: &mut CorsConfig) {
        overlay_field!(self, d, origins);
    }
}

impl PartialLogging {
    fn apply_to(&self, d: &mut LoggingConfig) {
        overlay_field!(self, d, level, format);
    }
}

impl PartialIce {
    fn apply_to(&self, d: &mut IceConfig) {
        overlay_field!(
            self,
            d,
            stun_servers,
            turn_url,
            turn_username,
            turn_credential,
            turn_credential_exposed
        );
    }
}

impl PartialAdmin {
    fn apply_to(&self, d: &mut AdminConfig) {
        overlay_field!(self, d, token);
    }
}

/// Parse a TOML string into a [`PartialConfig`].
pub fn parse_partial(text: &str) -> Result<PartialConfig, ConfigError> {
    Ok(toml::from_str::<PartialConfig>(text)?)
}

/// Read and parse a TOML configuration file.
pub fn read_partial(path: &Path) -> Result<PartialConfig, ConfigError> {
    let text = std::fs::read_to_string(path)?;
    parse_partial(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_toml_changes_nothing() {
        let partial = parse_partial("").expect("parse");
        let mut cfg = Config::default();
        let before = cfg.clone();
        partial.apply_to(&mut cfg);
        assert_eq!(before, cfg);
    }

    #[test]
    fn partial_overrides_only_present_keys() {
        let partial = parse_partial("[server]\nport = 8080\n").expect("parse");
        let mut cfg = Config::default();
        partial.apply_to(&mut cfg);
        assert_eq!(cfg.server.port, 8080);
        assert_eq!(cfg.server.host, "0.0.0.0");
    }

    #[test]
    fn parses_new_keys() {
        let text = r#"
[server]
trust_proxy_headers = true
allowed_ws_origins = ["https://a.example"]

[limits]
broadcast_queue_capacity = 128

[ice]
turn_credential_exposed = false
"#;
        let partial = parse_partial(text).expect("parse");
        let mut cfg = Config::default();
        partial.apply_to(&mut cfg);
        assert!(cfg.server.trust_proxy_headers);
        assert_eq!(cfg.server.allowed_ws_origins, vec!["https://a.example"]);
        assert_eq!(cfg.limits.broadcast_queue_capacity, 128);
        assert!(!cfg.ice.turn_credential_exposed);
    }

    #[test]
    fn parses_session_section() {
        let text = "[session]\ngrace_secs = 30\nsweep_interval_secs = 2\n";
        let partial = parse_partial(text).expect("parse");
        let mut cfg = Config::default();
        partial.apply_to(&mut cfg);
        assert_eq!(cfg.session.grace_secs, 30);
        assert_eq!(cfg.session.sweep_interval_secs, 2);
        // Untouched keys keep the built-in defaults.
        assert_eq!(cfg.timeouts.ws_idle_timeout_secs, 60);
    }

    #[test]
    fn redis_enabled_false_disables_relay() {        let partial = parse_partial("[redis]\nenabled = false\n").expect("parse");
        let mut cfg = Config::default();
        assert!(cfg.redis.enabled, "前置条件：默认启用");
        partial.apply_to(&mut cfg);
        assert!(!cfg.redis.enabled);
        assert!(!cfg.redis.is_active());
    }

    #[test]
    fn redis_enabled_true_keeps_relay_on() {
        let partial = parse_partial("[redis]\nenabled = true\n").expect("parse");
        let mut cfg = Config::default();
        partial.apply_to(&mut cfg);
        assert!(cfg.redis.is_active());
    }
}
