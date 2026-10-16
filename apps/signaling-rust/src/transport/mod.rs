//! Connection lifecycle, heartbeat, bounded broadcast queues, connection
//! registry and graceful shutdown.

pub mod connection;
pub mod heartbeat;
pub mod queue;
pub mod registry;
pub mod router;
pub mod shutdown;

use std::sync::{Arc, Mutex};

use crate::config::ConfigSnapshot;
use crate::metrics::Metrics;
use crate::protocol::ServerMsg;
use crate::relay::Relay;
use crate::rooms::{ConnHandle, PeerId, RoomCode, RoomTable};

pub use connection::{run_connection, ConnectionGuard};
pub use registry::{AdmitResult, ConnAdmission, ConnectionRegistry};
pub use router::Router;
pub use shutdown::{ConnTicket, Shutdown};

/// Mutable per-connection state.
#[derive(Debug, Default, Clone)]
pub struct ConnState {
    /// Room the connection currently belongs to, if any.
    pub current_room: Option<RoomCode>,
}

/// Per-connection context shared by the reader task, the router and the RAII
/// guard (so a dropped connection always leaves its room).
#[derive(Clone)]
pub struct ConnCtx {
    /// This connection's peer id.
    pub peer_id: PeerId,
    /// This node's id.
    pub node_id: Arc<str>,
    /// Outbound handle (bounded queue).
    pub handle: ConnHandle,
    /// Shared mutable state.
    pub state: Arc<Mutex<ConnState>>,
}

impl ConnCtx {
    /// Build a context for a fresh connection.
    pub fn new(peer_id: PeerId, node_id: Arc<str>, handle: ConnHandle) -> Self {
        Self {
            peer_id,
            node_id,
            handle,
            state: Arc::new(Mutex::new(ConnState::default())),
        }
    }

    /// Current room (clone).
    pub fn current_room(&self) -> Option<RoomCode> {
        self.state
            .lock()
            .map(|s| s.current_room.clone())
            .unwrap_or(None)
    }

    /// Set the current room.
    pub fn set_room(&self, code: RoomCode) {
        if let Ok(mut s) = self.state.lock() {
            s.current_room = Some(code);
        }
    }

    /// Take the current room, clearing it.
    pub fn take_room(&self) -> Option<RoomCode> {
        self.state
            .lock()
            .map(|mut s| s.current_room.take())
            .unwrap_or(None)
    }

    /// Non-blocking enqueue to this connection. Returns `true` when the client
    /// is slow and should be disconnected.
    pub fn send(&self, msg: ServerMsg) -> bool {
        self.handle.send(msg)
    }
}

/// Dependencies shared by every connection.
#[derive(Clone)]
pub struct ConnDeps {
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
    /// This node's id.
    pub node_id: Arc<str>,
}
