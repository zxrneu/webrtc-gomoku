//! An in-memory cluster used to simulate two nodes sharing one Redis without
//! any network dependency (T16).
//!
//! [`FakeCluster`] models both Redis roles the relay uses:
//! * the **global room registry** (`SET NX` / `SCARD` / `SREM` semantics), and
//! * the **per-room pub/sub bus** (a publish is delivered to every *other*
//!   node's [`LocalDelivery`]).
//!
//! [`FakeRelay`] is one node's [`Relay`] implementation; the delivery semantics
//! mirror `relay::subscriber::dispatch` exactly, so the cross-node tests
//! exercise the same decision table as production.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use gomoku_signaling::protocol::{self, messages};
use gomoku_signaling::relay::{
    CrossKind, CrossNodeMsg, JoinStatus, LeaveStatus, Relay, RelayError,
};
use gomoku_signaling::rooms::{LocalDelivery, PeerId, RoomCode};

/// The shared "Redis": a room→members map plus the set of participating nodes.
#[derive(Default)]
pub struct FakeCluster {
    /// room code → member ids (`{node_id}:{peer_id}`), mirroring the Redis set.
    rooms: Mutex<HashMap<String, HashSet<String>>>,
    /// node id → that node's local delivery sink.
    nodes: Mutex<Vec<(String, Arc<dyn LocalDelivery>)>>,
}

impl FakeCluster {
    /// Create a shared, empty cluster.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Number of rooms currently registered (test observability).
    pub fn room_count(&self) -> usize {
        self.rooms.lock().expect("rooms lock").len()
    }

    /// Number of members in `code`'s member set (test observability for F6).
    pub fn member_count(&self, code: &str) -> usize {
        self.rooms
            .lock()
            .expect("rooms lock")
            .get(code)
            .map(|m| m.len())
            .unwrap_or(0)
    }

    /// Test-only: drop `member` from `code`'s member set.
    ///
    /// Simulates a divergence between the Redis registry and the local room
    /// table (e.g. a stale residue from the pre-F6 compensation bug, or a
    /// ghost room left by an expired TTL) — the exact state the F6 rollback
    /// logic must recover from.
    pub fn force_remove_member(&self, code: &str, member: &str) {
        let mut rooms = self.rooms.lock().expect("rooms lock");
        if let Some(members) = rooms.get_mut(code) {
            members.remove(member);
        }
    }
}

/// One node's relay, wired to the shared [`FakeCluster`].
pub struct FakeRelay {
    node_id: String,
    cluster: Arc<FakeCluster>,
    /// Ordered log of relay operations, e.g. `["join:AB12",
    /// "subscribe:AB12", "publish:AB12"]` (test observability for F5/F6).
    calls: Mutex<Vec<String>>,
}

impl FakeRelay {
    /// Register `delivery` as `node_id`'s sink and return its relay.
    pub fn new(
        node_id: &str,
        cluster: Arc<FakeCluster>,
        delivery: Arc<dyn LocalDelivery>,
    ) -> Arc<Self> {
        cluster
            .nodes
            .lock()
            .expect("nodes lock")
            .push((node_id.to_string(), delivery));
        Arc::new(Self {
            node_id: node_id.to_string(),
            cluster,
            calls: Mutex::new(Vec::new()),
        })
    }

    /// Ordered operation log (F5: subscribe-before-publish ordering).
    pub fn call_log(&self) -> Vec<String> {
        self.calls.lock().expect("calls lock").clone()
    }

    /// Room codes passed to [`Relay::refresh_rooms`] (F4: TTL keep-alive).
    pub fn refreshed_codes(&self) -> Vec<String> {
        self.call_log()
            .into_iter()
            .filter_map(|c| c.strip_prefix("refresh:").map(str::to_string))
            .collect()
    }

    fn record(&self, op: &str) {
        self.calls.lock().expect("calls lock").push(op.to_string());
    }
}

#[async_trait]
impl Relay for FakeRelay {
    async fn publish(&self, msg: CrossNodeMsg) -> Result<(), RelayError> {
        self.record(&format!("publish:{}", msg.room));
        // Fan out to every *other* node, exactly like a Redis channel would.
        let nodes = self.cluster.nodes.lock().expect("nodes lock");
        for (node_id, delivery) in nodes.iter() {
            if node_id == &self.node_id {
                continue; // the publisher already handled its own local peers
            }
            dispatch(delivery.as_ref(), &msg);
        }
        Ok(())
    }

    async fn subscribe_room(&self, code: &RoomCode) {
        self.record(&format!("subscribe:{code}"));
        // The fake bus delivers to every node; subscription is a no-op.
    }

    async fn unsubscribe_room(&self, code: &RoomCode) {
        self.record(&format!("unsubscribe:{code}"));
    }

    async fn registry_create(
        &self,
        code: &RoomCode,
        member: &str,
        _ttl_secs: u64,
    ) -> Result<bool, RelayError> {
        self.record(&format!("create:{code}"));
        let mut rooms = self.cluster.rooms.lock().expect("rooms lock");
        if rooms.contains_key(code.as_str()) {
            return Ok(false); // SET NX fails: the key already exists
        }
        let mut members = HashSet::new();
        members.insert(member.to_string());
        rooms.insert(code.as_str().to_string(), members);
        Ok(true)
    }

    async fn registry_join(
        &self,
        code: &RoomCode,
        member: &str,
        _ttl_secs: u64,
    ) -> Result<JoinStatus, RelayError> {
        self.record(&format!("join:{code}"));
        let mut rooms = self.cluster.rooms.lock().expect("rooms lock");
        match rooms.get_mut(code.as_str()) {
            None => Ok(JoinStatus::NotFound),
            Some(members) => {
                if members.len() >= 2 {
                    Ok(JoinStatus::Full)
                } else {
                    members.insert(member.to_string());
                    Ok(JoinStatus::Joined)
                }
            }
        }
    }

    async fn registry_leave(
        &self,
        code: &RoomCode,
        member: &str,
    ) -> Result<LeaveStatus, RelayError> {
        self.record(&format!("leave:{code}"));
        let mut rooms = self.cluster.rooms.lock().expect("rooms lock");
        match rooms.get_mut(code.as_str()) {
            None => Ok(LeaveStatus::RoomDeleted),
            Some(members) => {
                members.remove(member);
                if members.is_empty() {
                    rooms.remove(code.as_str());
                    Ok(LeaveStatus::RoomDeleted)
                } else {
                    Ok(LeaveStatus::Removed)
                }
            }
        }
    }

    async fn refresh_rooms(&self, codes: &[RoomCode], _ttl_secs: u64) {
        for code in codes {
            self.record(&format!("refresh:{code}"));
        }
    }

    fn is_connected(&self) -> bool {
        true
    }
}

/// Deliver a cross-node message to a node's local peers, mirroring
/// `relay::subscriber::dispatch`.
fn dispatch(delivery: &dyn LocalDelivery, msg: &CrossNodeMsg) {
    let code = match RoomCode::new(&msg.room) {
        Ok(code) => code,
        Err(_) => return,
    };
    let from_peer = match PeerId::new(&msg.from_peer) {
        Ok(peer) => peer,
        Err(_) => return,
    };
    let target = msg.target.as_deref().and_then(|t| PeerId::new(t).ok());

    let server_msg = match msg.kind {
        CrossKind::PeerJoined => {
            messages::peer_joined(from_peer.as_str(), msg.name.as_deref().unwrap_or_default())
        }
        CrossKind::PeerLeft => messages::peer_left(),
        CrossKind::PeerOffline => messages::peer_offline(msg.grace_sec.unwrap_or(60)),
        CrossKind::PeerOnline => messages::peer_online(),
        CrossKind::Signal => {
            let data = msg.payload.clone().unwrap_or(serde_json::Value::Null);
            if protocol::is_falsy(&data) {
                return;
            }
            messages::signal(data)
        }
    };

    match target {
        Some(target) => delivery.deliver(&code, &target, server_msg),
        None => delivery.deliver_others(&code, Some(&from_peer), server_msg),
    }
}
