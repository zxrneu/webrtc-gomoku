//! HTTP layer: axum router, static hosting, `/healthz`, `/config`, `/metrics`
//! and the `/signal` WS upgrade.

pub mod config_endpoint;
pub mod health;
pub mod mime;
pub mod router;
pub mod server;
pub mod static_files;
pub mod ws;

pub use crate::state::{AppState, LogLevelSetter};
pub use server::serve;

/// Test-only constructor shared by the HTTP unit tests.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Instant;

    use crate::config::{Config, ConfigSnapshot};
    use crate::metrics::Metrics;
    use crate::relay::RelayManager;
    use crate::rooms::RoomTable;
    use crate::state::AppState;
    use crate::transport::registry::ConnectionRegistry;
    use crate::transport::seat::SeatRegistry;
    use crate::transport::shutdown::Shutdown;

    /// Build an [`AppState`] from a configuration with sensible test defaults.
    pub fn state_with(cfg: Config) -> AppState {
        AppState {
            cfg: Arc::new(ConfigSnapshot::new(cfg)),
            rooms: Arc::new(RoomTable::default()),
            conns: Arc::new(ConnectionRegistry::new(100, 10)),
            relay: Arc::new(RelayManager::disabled("gomoku:signal")),
            metrics: Arc::new(Metrics::new()),
            shutdown: Shutdown::new(),
            seats: Arc::new(SeatRegistry::default()),
            node_id: Arc::from("test-node"),
            started: Instant::now(),
            public_dir: PathBuf::from("public"),
            log_level: None,
        }
    }
}
