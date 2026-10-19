//! Connection lifecycle, heartbeat, bounded broadcast queues, connection
//! registry, seat preservation and graceful shutdown.

pub mod connection;
pub mod heartbeat;
pub mod lobby;
pub mod queue;
pub mod registry;
pub mod router;
pub mod seat;
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
pub use seat::{Seat, SeatRegistry, SeatRole, VerifyResult};
pub use shutdown::{ConnTicket, Shutdown};

/// Mutable per-connection state.
///
/// Everything here can change while the connection is alive:
/// * `current_room` — set by `create`/`join`, cleared by `leave`;
/// * `peer_id` — **rewritten by `resume`** (the new socket inherits the seat's
///   identity);
/// * `handle` — rewritten together with `peer_id`, because the room table keys
///   members by peer id and routes through the handle's outbound queue.
pub struct ConnState {
    /// This connection's peer id (mutable: `resume` adopts the old one).
    pub peer_id: PeerId,
    /// Outbound handle (bounded queue).
    pub handle: ConnHandle,
    /// Room the connection currently belongs to, if any.
    pub current_room: Option<RoomCode>,
    /// Once another socket takes this identity, it must reconnect with a fresh id.
    pub superseded: bool,
}

/// Per-connection context shared by the reader task, the router and the RAII
/// guard (so a dropped connection always settles its seat).
#[derive(Clone)]
pub struct ConnCtx {
    /// This node's id.
    pub node_id: Arc<str>,
    /// Monotonic physical-connection id (`seat.owner_conn`).
    ///
    /// Never rewritten — that is exactly what makes a *late* `close` from a
    /// superseded socket harmless.
    pub conn_id: u64,
    state: Arc<Mutex<ConnState>>,
}

impl ConnCtx {
    /// Build a context for a fresh connection.
    pub fn new(conn_id: u64, peer_id: PeerId, node_id: Arc<str>, handle: ConnHandle) -> Self {
        Self {
            node_id,
            conn_id,
            state: Arc::new(Mutex::new(ConnState {
                peer_id,
                handle,
                current_room: None,
                superseded: false,
            })),
        }
    }

    /// Current peer id (clone).
    pub fn peer_id(&self) -> PeerId {
        self.lock().peer_id.clone()
    }

    /// Current outbound handle (clone).
    pub fn handle(&self) -> ConnHandle {
        self.lock().handle.clone()
    }

    /// Current room (clone).
    pub fn current_room(&self) -> Option<RoomCode> {
        self.lock().current_room.clone()
    }

    /// Set the current room.
    pub fn set_room(&self, code: RoomCode) {
        self.lock().current_room = Some(code);
    }

    /// Take the current room, clearing it.
    pub fn take_room(&self) -> Option<RoomCode> {
        self.lock().current_room.take()
    }

    /// Whether this physical socket has permanently lost its identity.
    pub fn is_superseded(&self) -> bool {
        self.lock().superseded
    }

    /// Revoke this socket without leaving the replacement socket's room.
    pub fn mark_superseded(&self) {
        let mut state = self.lock();
        state.superseded = true;
        state.current_room = None;
    }

    /// Adopt the identity of a seat during `resume`.
    ///
    /// The outbound queue is preserved (same socket, same writer task); only the
    /// peer id changes, and the returned handle is the one that must be
    /// re-bound in the room table. Returns `None` only if the state lock is
    /// poisoned beyond recovery (never in practice).
    pub fn adopt_peer(&self, peer_id: PeerId) -> ConnHandle {
        let mut state = self.lock();
        let handle = state.handle.with_peer_id(peer_id.clone());
        state.peer_id = peer_id;
        state.handle = handle.clone();
        handle
    }

    /// Non-blocking enqueue to this connection. Returns `true` when the client
    /// is slow and should be disconnected.
    pub fn send(&self, msg: ServerMsg) -> bool {
        self.handle().send(msg)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ConnState> {
        match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// Dependencies shared by every connection.
#[derive(Clone)]
pub struct ConnDeps {
    /// Node-local discovery and invitation coordinator.
    pub lobby: Arc<tokio::sync::Mutex<lobby::Lobby>>,
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
    /// Seat table (grace window + resume credentials).
    pub seats: Arc<SeatRegistry>,
    /// This node's id.
    pub node_id: Arc<str>,
}
