//! Cross-module integration test for the three-layer configuration merge
//! (T03): built-in defaults < `config.toml` < environment, plus validation and
//! secret redaction.
//!
//! The unit tests inside `src/config/*` cover each layer in isolation; this
//! file exercises the *whole* `Config::assemble` pipeline exactly as the binary
//! uses it at startup.

use std::path::Path;

use gomoku_signaling::config::{env, Config, ConfigError, MapEnv, REDACTED};

/// Write `text` to `dir/config.toml` and return the path.
fn write_config(dir: &Path, text: &str) -> std::path::PathBuf {
    let path = dir.join("config.toml");
    std::fs::write(&path, text).expect("write config");
    path
}

#[test]
fn builtin_defaults_apply_when_nothing_is_supplied() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = dir.path().join("does-not-exist.toml");

    let cfg = Config::assemble(&missing, &MapEnv::default()).expect("assemble");

    // A representative sample of PRD §5.2 defaults.
    assert_eq!(cfg.server.host, "0.0.0.0");
    assert_eq!(cfg.server.port, 3000);
    assert_eq!(cfg.server.public_dir, "public");
    assert_eq!(cfg.timeouts.ws_ping_interval_secs, 30);
    assert_eq!(cfg.timeouts.ws_idle_timeout_secs, 60);
    assert_eq!(cfg.timeouts.ws_handshake_timeout_secs, 10);
    assert_eq!(cfg.timeouts.shutdown_drain_secs, 15);
    assert_eq!(cfg.limits.max_connections, 100_000);
    assert_eq!(cfg.limits.max_connections_per_ip, 10);
    assert_eq!(cfg.limits.max_rooms, 50_000);
    assert_eq!(cfg.limits.max_message_bytes, 65_536);
    assert_eq!(cfg.limits.broadcast_queue_capacity, 256);
    assert_eq!(cfg.redis.url, "redis://127.0.0.1:6379");
    assert_eq!(cfg.redis.pool_size, 16);
    assert_eq!(cfg.redis.channel_prefix, "gomoku:signal");
    assert_eq!(cfg.redis.connect_timeout_ms, 5_000);
    assert_eq!(cfg.redis.room_ttl_secs, 3_600);
    assert_eq!(cfg.logging.level, "info");
    assert_eq!(cfg.logging.format, "text");
    assert_eq!(cfg.ice.stun_servers.len(), 4);
    assert!(cfg.ice.turn_credential_exposed);
    assert!(!cfg.server.trust_proxy_headers);
    assert!(cfg.server.allowed_ws_origins.is_empty());
    assert!(cfg.admin.token.is_empty());
}

#[test]
fn file_overrides_builtin_and_env_overrides_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = write_config(
        dir.path(),
        r#"
[server]
host = "10.0.0.1"
port = 8080
allowed_ws_origins = ["https://from-file.example"]

[limits]
max_rooms = 123
broadcast_queue_capacity = 128

[ice]
turn_url = "turn:file.example:3478"
turn_credential_exposed = false
"#,
    );

    // Layer 2: file overrides the built-in defaults.
    let from_file = Config::assemble(&path, &MapEnv::default()).expect("assemble");
    assert_eq!(from_file.server.host, "10.0.0.1");
    assert_eq!(from_file.server.port, 8080);
    assert_eq!(
        from_file.server.allowed_ws_origins,
        vec!["https://from-file.example"]
    );
    assert_eq!(from_file.limits.max_rooms, 123);
    assert_eq!(from_file.limits.broadcast_queue_capacity, 128);
    assert_eq!(from_file.ice.turn_url, "turn:file.example:3478");
    assert!(!from_file.ice.turn_credential_exposed);

    // Layer 3: environment overrides the file (scalars, lists and booleans).
    let envsrc = MapEnv::new(&[
        (env::PORT, "9090"),
        (env::MAX_ROOMS, "7"),
        (env::CORS_ORIGINS, "https://a.example, https://b.example"),
        (env::TRUST_PROXY_HEADERS, "true"),
        (env::TURN_CREDENTIAL_EXPOSED, "true"),
        (env::BROADCAST_QUEUE_CAPACITY, "512"),
    ]);
    let merged = Config::assemble(&path, &envsrc).expect("assemble");

    // Overridden by env:
    assert_eq!(merged.server.port, 9090);
    assert_eq!(merged.limits.max_rooms, 7);
    assert_eq!(merged.limits.broadcast_queue_capacity, 512);
    assert!(merged.server.trust_proxy_headers);
    assert!(merged.ice.turn_credential_exposed);
    assert_eq!(
        merged.cors.origins,
        vec!["https://a.example", "https://b.example"]
    );
    // Not overridden by env → keeps the file value:
    assert_eq!(merged.server.host, "10.0.0.1");
    assert_eq!(merged.ice.turn_url, "turn:file.example:3478");
    assert_eq!(
        merged.server.allowed_ws_origins,
        vec!["https://from-file.example"]
    );
}

#[test]
fn config_example_toml_round_trips_to_the_documented_defaults() {
    // `config.example.toml` is the shipped, fully-populated sample. Parsing it
    // must reproduce every documented default (T02 acceptance).
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config.example.toml");
    assert!(path.exists(), "config.example.toml must exist");

    let cfg = Config::assemble(&path, &MapEnv::default()).expect("assemble example");
    let builtin = Config::default();

    // `cluster.node_id` is process-stable but random per process, and the
    // example pins an explicit value; compare the rest field by field.
    assert_eq!(cfg.server, builtin.server);
    assert_eq!(cfg.timeouts, builtin.timeouts);
    assert_eq!(cfg.limits, builtin.limits);
    assert_eq!(cfg.redis, builtin.redis);
    assert_eq!(cfg.cors, builtin.cors);
    assert_eq!(cfg.logging, builtin.logging);
    assert_eq!(cfg.ice, builtin.ice);
    assert_eq!(cfg.admin, builtin.admin);
}

#[test]
fn invalid_values_are_rejected_with_a_keyed_error() {
    let dir = tempfile::tempdir().expect("tempdir");

    // Port 0.
    let path = write_config(dir.path(), "[server]\nport = 0\n");
    let err = Config::assemble(&path, &MapEnv::default()).unwrap_err();
    assert!(
        matches!(err, ConfigError::Invalid { ref key, .. } if key == "server.port"),
        "unexpected error: {err:?}"
    );

    // Non-redis URL.
    let path = write_config(dir.path(), "[redis]\nurl = \"http://localhost\"\n");
    let err = Config::assemble(&path, &MapEnv::default()).unwrap_err();
    assert!(
        matches!(err, ConfigError::Invalid { ref key, .. } if key == "redis.url"),
        "unexpected error: {err:?}"
    );

    // Zero timeout.
    let path = write_config(dir.path(), "[timeouts]\nws_idle_timeout_secs = 0\n");
    let err = Config::assemble(&path, &MapEnv::default()).unwrap_err();
    assert!(
        matches!(err, ConfigError::Invalid { ref key, .. } if key == "timeouts.ws_idle_timeout_secs"),
        "unexpected error: {err:?}"
    );

    // per-IP cap above the global cap.
    let path = write_config(
        dir.path(),
        "[limits]\nmax_connections = 5\nmax_connections_per_ip = 10\n",
    );
    let err = Config::assemble(&path, &MapEnv::default()).unwrap_err();
    assert!(
        matches!(err, ConfigError::Invalid { ref key, .. } if key == "limits.max_connections_per_ip"),
        "unexpected error: {err:?}"
    );
}

#[test]
fn environment_parse_error_is_reported() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("none.toml");
    let envsrc = MapEnv::new(&[(env::PORT, "not-a-number")]);

    let err = Config::assemble(&path, &envsrc).unwrap_err();
    assert!(
        matches!(err, ConfigError::Env { ref var, .. } if var == env::PORT),
        "unexpected error: {err:?}"
    );
}

#[test]
fn redacted_view_masks_every_secret() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = write_config(
        dir.path(),
        r#"
[admin]
token = "super-secret-admin"

[redis]
url = "redis://user:hunter2@redis.example:6379"

[ice]
turn_url = "turn:t.example:3478"
turn_credential = "turn-password"
"#,
    );
    let cfg = Config::assemble(&path, &MapEnv::default()).expect("assemble");

    // The live config still holds the real secrets...
    assert_eq!(cfg.admin.token, "super-secret-admin");
    assert_eq!(cfg.ice.turn_credential, "turn-password");

    // ...but the redacted view never leaks them.
    let redacted = cfg.redacted();
    assert_eq!(redacted.admin.token, REDACTED);
    assert_eq!(redacted.ice.turn_credential, REDACTED);
    assert_eq!(redacted.redis.url, "redis://user:***@redis.example:6379");

    let json = cfg.redacted_json().to_string();
    assert!(!json.contains("super-secret-admin"));
    assert!(!json.contains("hunter2"));
    assert!(!json.contains("turn-password"));
    assert!(json.contains(REDACTED));
}
