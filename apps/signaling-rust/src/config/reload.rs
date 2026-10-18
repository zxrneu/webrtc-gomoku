//! Hot reload: read file + env → merge → validate → diff → `ArcSwap::store`.

use std::path::Path;

use serde::Serialize;

use crate::config::{Config, ConfigError, ConfigSnapshot, EnvSource};

/// Outcome of a reload attempt.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ReloadReport {
    /// Keys that took effect immediately (no restart needed).
    pub applied: Vec<String>,
    /// Keys that changed but require a process restart.
    pub restart_required: Vec<String>,
}

impl ReloadReport {
    /// `true` when nothing changed.
    pub fn is_empty(&self) -> bool {
        self.applied.is_empty() && self.restart_required.is_empty()
    }
}

/// Keys whose change requires a restart (PRD §5.3, F3).
///
/// `redis.enabled` is included because starting/stopping the background
/// connector is not a hot-swappable operation — the task is spawned once at
/// startup. Claiming it as `applied` would be a lie.
///
/// The remaining additions (F3) are honest classification: their handlers are
/// frozen at startup — CORS and the HTTP body limit are middleware layers
/// built during router assembly, the Redis pool size / channel prefix /
/// connect timeout are installed when the background connector succeeds, the
/// node id is baked into `AppState`, and the logging format is chosen when
/// the tracing subscriber is initialised. None of them take effect before
/// the next process start, so they must be reported as `restart_required`
/// instead of a fictitious `applied`.
const RESTART_KEYS: &[&str] = &[
    "server.host",
    "server.port",
    "server.public_dir",
    "cors.origins",
    "timeouts.ws_handshake_timeout_secs",
    "timeouts.shutdown_drain_secs",
    "limits.max_message_bytes",
    "logging.format",
    "redis.enabled",
    "redis.url",
    "redis.pool_size",
    "redis.channel_prefix",
    "redis.connect_timeout_ms",
    "cluster.node_id",
];

fn changed(key: &str, differs: bool, applied: &mut Vec<String>, restart: &mut Vec<String>) {
    if !differs {
        return;
    }
    if RESTART_KEYS.contains(&key) {
        restart.push(key.to_string());
    } else {
        applied.push(key.to_string());
    }
}

/// Compute the diff between two configurations.
pub fn compute_reload_report(old: &Config, new: &Config) -> ReloadReport {
    let mut applied = Vec::new();
    let mut restart = Vec::new();

    changed(
        "server.host",
        old.server.host != new.server.host,
        &mut applied,
        &mut restart,
    );
    changed(
        "server.port",
        old.server.port != new.server.port,
        &mut applied,
        &mut restart,
    );
    changed(
        "server.public_dir",
        old.server.public_dir != new.server.public_dir,
        &mut applied,
        &mut restart,
    );
    changed(
        "server.allowed_ws_origins",
        old.server.allowed_ws_origins != new.server.allowed_ws_origins,
        &mut applied,
        &mut restart,
    );
    changed(
        "server.trust_proxy_headers",
        old.server.trust_proxy_headers != new.server.trust_proxy_headers,
        &mut applied,
        &mut restart,
    );

    changed(
        "timeouts.ws_ping_interval_secs",
        old.timeouts.ws_ping_interval_secs != new.timeouts.ws_ping_interval_secs,
        &mut applied,
        &mut restart,
    );
    changed(
        "timeouts.ws_idle_timeout_secs",
        old.timeouts.ws_idle_timeout_secs != new.timeouts.ws_idle_timeout_secs,
        &mut applied,
        &mut restart,
    );
    changed(
        "timeouts.ws_handshake_timeout_secs",
        old.timeouts.ws_handshake_timeout_secs != new.timeouts.ws_handshake_timeout_secs,
        &mut applied,
        &mut restart,
    );
    changed(
        "timeouts.shutdown_drain_secs",
        old.timeouts.shutdown_drain_secs != new.timeouts.shutdown_drain_secs,
        &mut applied,
        &mut restart,
    );

    // `[session]`: the sweeper re-reads the snapshot every tick, so both keys
    // take effect without a restart (seats already in grace keep their
    // absolute expiry — no retroactive shortening).
    changed(
        "session.grace_secs",
        old.session.grace_secs != new.session.grace_secs,
        &mut applied,
        &mut restart,
    );
    changed(
        "session.sweep_interval_secs",
        old.session.sweep_interval_secs != new.session.sweep_interval_secs,
        &mut applied,
        &mut restart,
    );

    changed(
        "limits.max_connections",
        old.limits.max_connections != new.limits.max_connections,
        &mut applied,
        &mut restart,
    );
    changed(
        "limits.max_connections_per_ip",
        old.limits.max_connections_per_ip != new.limits.max_connections_per_ip,
        &mut applied,
        &mut restart,
    );
    changed(
        "limits.max_rooms",
        old.limits.max_rooms != new.limits.max_rooms,
        &mut applied,
        &mut restart,
    );
    changed(
        "limits.max_message_bytes",
        old.limits.max_message_bytes != new.limits.max_message_bytes,
        &mut applied,
        &mut restart,
    );
    changed(
        "limits.broadcast_queue_capacity",
        old.limits.broadcast_queue_capacity != new.limits.broadcast_queue_capacity,
        &mut applied,
        &mut restart,
    );

    changed(
        "redis.enabled",
        old.redis.enabled != new.redis.enabled,
        &mut applied,
        &mut restart,
    );
    changed(
        "redis.url",
        old.redis.url != new.redis.url,
        &mut applied,
        &mut restart,
    );
    changed(
        "redis.pool_size",
        old.redis.pool_size != new.redis.pool_size,
        &mut applied,
        &mut restart,
    );
    changed(
        "redis.channel_prefix",
        old.redis.channel_prefix != new.redis.channel_prefix,
        &mut applied,
        &mut restart,
    );
    changed(
        "redis.connect_timeout_ms",
        old.redis.connect_timeout_ms != new.redis.connect_timeout_ms,
        &mut applied,
        &mut restart,
    );
    changed(
        "redis.room_ttl_secs",
        old.redis.room_ttl_secs != new.redis.room_ttl_secs,
        &mut applied,
        &mut restart,
    );

    changed(
        "cluster.node_id",
        old.cluster.node_id != new.cluster.node_id,
        &mut applied,
        &mut restart,
    );
    changed(
        "cluster.nodes",
        old.cluster.nodes != new.cluster.nodes,
        &mut applied,
        &mut restart,
    );

    changed(
        "cors.origins",
        old.cors.origins != new.cors.origins,
        &mut applied,
        &mut restart,
    );

    changed(
        "logging.level",
        old.logging.level != new.logging.level,
        &mut applied,
        &mut restart,
    );
    changed(
        "logging.format",
        old.logging.format != new.logging.format,
        &mut applied,
        &mut restart,
    );

    changed(
        "ice.stun_servers",
        old.ice.stun_servers != new.ice.stun_servers,
        &mut applied,
        &mut restart,
    );
    changed(
        "ice.turn_url",
        old.ice.turn_url != new.ice.turn_url,
        &mut applied,
        &mut restart,
    );
    changed(
        "ice.turn_username",
        old.ice.turn_username != new.ice.turn_username,
        &mut applied,
        &mut restart,
    );
    changed(
        "ice.turn_credential",
        old.ice.turn_credential != new.ice.turn_credential,
        &mut applied,
        &mut restart,
    );
    changed(
        "ice.turn_credential_exposed",
        old.ice.turn_credential_exposed != new.ice.turn_credential_exposed,
        &mut applied,
        &mut restart,
    );

    changed(
        "admin.token",
        old.admin.token != new.admin.token,
        &mut applied,
        &mut restart,
    );

    ReloadReport {
        applied,
        restart_required: restart,
    }
}

/// Rebuild the configuration from disk + environment, validate it, and — only
/// when valid — store it into `snapshot`, returning the diff report.
///
/// On an invalid configuration the previous snapshot is preserved and the error
/// is returned (the process keeps running with the old configuration).
pub fn reload(
    snapshot: &ConfigSnapshot,
    path: &Path,
    env: &dyn EnvSource,
) -> Result<ReloadReport, ConfigError> {
    let new = Config::assemble(path, env)?;
    let old = snapshot.snapshot();
    let report = compute_reload_report(&old, &new);
    snapshot.store(new);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_change_yields_empty_report() {
        let a = Config::default();
        let b = Config::default();
        let r = compute_reload_report(&a, &b);
        assert!(r.is_empty());
    }

    #[test]
    fn hot_keys_go_to_applied() {
        let a = Config::default();
        let mut b = a.clone();
        b.logging.level = "debug".into();
        b.limits.max_connections = 5;
        let r = compute_reload_report(&a, &b);
        assert!(r.applied.contains(&"logging.level".to_string()));
        assert!(r.applied.contains(&"limits.max_connections".to_string()));
        assert!(r.restart_required.is_empty());
    }

    #[test]
    fn listener_keys_go_to_restart_required() {
        let a = Config::default();
        let mut b = a.clone();
        b.server.port = 8081;
        b.redis.url = "redis://other:6379".into();
        let r = compute_reload_report(&a, &b);
        assert!(r.restart_required.contains(&"server.port".to_string()));
        assert!(r.restart_required.contains(&"redis.url".to_string()));
        assert!(r.applied.is_empty());
    }

    #[test]
    fn toggling_redis_requires_restart() {
        let a = Config::default();
        let mut b = a.clone();
        b.redis.enabled = false;
        let r = compute_reload_report(&a, &b);
        assert!(
            r.restart_required.contains(&"redis.enabled".to_string()),
            "redis.enabled 需重启才能生效，应报 restart_required"
        );
        assert!(!r.applied.contains(&"redis.enabled".to_string()));
    }

    /// F3: keys whose handlers are frozen at startup (router/middleware
    /// layers, connection pools, node identity) must be reported honestly
    /// as `restart_required` — claiming `applied` would be a lie.
    #[test]
    fn startup_frozen_keys_are_reported_as_restart_required() {
        let a = Config::default();
        let mut b = a.clone();
        b.cors.origins = vec!["https://changed.example".into()];
        b.logging.format = "json".into();
        b.timeouts.ws_handshake_timeout_secs = 20;
        b.timeouts.shutdown_drain_secs = 30;
        b.limits.max_message_bytes = 1024;
        b.redis.pool_size = 4;
        b.redis.channel_prefix = "other:signal".into();
        b.redis.connect_timeout_ms = 1000;
        b.cluster.node_id = "other-node".into();
        let r = compute_reload_report(&a, &b);

        let frozen = [
            "cors.origins",
            "logging.format",
            "timeouts.ws_handshake_timeout_secs",
            "timeouts.shutdown_drain_secs",
            "limits.max_message_bytes",
            "redis.pool_size",
            "redis.channel_prefix",
            "redis.connect_timeout_ms",
            "cluster.node_id",
        ];
        for key in frozen {
            assert!(
                r.restart_required.contains(&key.to_string()),
                "{key} 启动时固化，必须报 restart_required，实际报告: {r:?}"
            );
            assert!(
                !r.applied.contains(&key.to_string()),
                "{key} 不得谎报 applied，实际报告: {r:?}"
            );
        }
    }

    #[test]
    fn invalid_config_is_rejected_and_keeps_old_snapshot() {
        let dir = std::env::temp_dir().join(format!("gomoku-reload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let file = dir.join("config.toml");
        std::fs::write(&file, "[server]\nport = 0\n").expect("write");

        let snapshot = ConfigSnapshot::new(Config::default());
        let env = crate::config::MapEnv::default();
        let err = reload(&snapshot, &file, &env).unwrap_err();
        assert!(matches!(err, ConfigError::Invalid { .. }));
        // old snapshot preserved
        assert_eq!(snapshot.snapshot().server.port, 3000);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn valid_config_is_applied() {
        let dir = std::env::temp_dir().join(format!("gomoku-reload-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let file = dir.join("config.toml");
        std::fs::write(&file, "[logging]\nlevel = \"debug\"\n").expect("write");

        let snapshot = ConfigSnapshot::new(Config::default());
        let env = crate::config::MapEnv::default();
        let report = reload(&snapshot, &file, &env).expect("reload");
        assert!(report.applied.contains(&"logging.level".to_string()));
        assert_eq!(snapshot.snapshot().logging.level, "debug");

        std::fs::remove_dir_all(&dir).ok();
    }
}
