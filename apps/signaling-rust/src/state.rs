//! Shared application state.
//!
//! `AppState` is used by both the `http` layer (routers/handlers) and the
//! `admin` layer (management handlers). It therefore lives in this neutral
//! module so the dependency direction stays one-way:
//!
//! ```text
//! state ◄─ admin ◄─ http ◄─ main
//! ```
//!
//! `admin` never imports `http` (architecture §1.3).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use crate::config::{Config, ConfigSnapshot};
use crate::metrics::Metrics;
use crate::relay::Relay;
use crate::rooms::RoomTable;
use crate::transport::registry::ConnectionRegistry;
use crate::transport::shutdown::Shutdown;
use crate::transport::ConnDeps;

/// Callback used to change the tracing filter level at runtime.
pub type LogLevelSetter = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    /// Configuration snapshot.
    pub cfg: Arc<ConfigSnapshot>,
    /// Room table.
    pub rooms: Arc<RoomTable>,
    /// Connection registry.
    pub conns: Arc<ConnectionRegistry>,
    /// Cross-node relay.
    pub relay: Arc<dyn Relay>,
    /// Metrics registry.
    pub metrics: Arc<Metrics>,
    /// Shutdown token.
    pub shutdown: Shutdown,
    /// This node's id.
    pub node_id: Arc<str>,
    /// Process start time (for `uptime`).
    pub started: Instant,
    /// Resolved static directory (fallback-probed at startup).
    pub public_dir: PathBuf,
    /// Optional runtime log-level setter (hot reload).
    pub log_level: Option<LogLevelSetter>,
}

impl AppState {
    /// Build the connection-level dependency bundle.
    pub fn conn_deps(&self) -> ConnDeps {
        ConnDeps {
            cfg: self.cfg.clone(),
            rooms: self.rooms.clone(),
            conns: self.conns.clone(),
            relay: self.relay.clone(),
            metrics: self.metrics.clone(),
            node_id: self.node_id.clone(),
        }
    }

    /// Apply runtime side effects of a (validated) configuration.
    ///
    /// Connection-level parameters apply to *new* connections; global
    /// parameters (limits, log level) take effect immediately.
    pub fn apply_runtime(&self, cfg: &Config) {
        self.conns.set_limits(
            cfg.limits.max_connections,
            cfg.limits.max_connections_per_ip,
        );
        self.rooms.set_max_rooms(u64::from(cfg.limits.max_rooms));
        if let Some(setter) = &self.log_level {
            let _ = setter(&cfg.logging.level);
        }
    }
}
