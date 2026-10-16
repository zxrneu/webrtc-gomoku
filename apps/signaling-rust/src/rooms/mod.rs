//! In-node room table and member index.
//!
//! ## Why sharding
//!
//! At 100k connections / 50k rooms a single global `Mutex<HashMap>` would be a
//! hot lock (every create/join/leave contends). We use [`SHARD_COUNT`] shards
//! behind `RwLock` (read-mostly) and a lock-free `AtomicU64` room counter.
//!
//! ## What is deliberately *not* here
//!
//! There is no global `peer → room` index: each connection task owns its own
//! `current_room`, so leave/create can locate the shard directly.

pub mod code;

pub use code::{
    generate_peer_id, generate_room_code, is_valid_peer_id, is_valid_room_code, random_token,
    PeerId, PeerIdError, RoomCode, RoomCodeError, PEER_ID_LEN, ROOM_CODE_LEN,
};

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use thiserror::Error;
use tokio::sync::mpsc;
use tokio::sync::Notify;

use crate::protocol::ServerMsg;

/// Number of room-table shards (power of two).
pub const SHARD_COUNT: usize = 64;

/// Maximum members per room (1v1).
pub const MAX_ROOM_MEMBERS: usize = 2;

/// A connection-level handle: carries the bounded outbound queue sender.
#[derive(Clone)]
pub struct ConnHandle {
    /// Peer id of the connection.
    pub peer_id: PeerId,
    /// Node id owning the connection.
    pub node_id: Arc<str>,
    /// Bounded outbound queue (back-pressure key).
    pub tx: mpsc::Sender<ServerMsg>,
    /// Signalled when the outbound queue is full (slow client).
    slow: Arc<Notify>,
}

impl ConnHandle {
    /// Build a handle from its parts.
    pub fn new(
        peer_id: PeerId,
        node_id: Arc<str>,
        tx: mpsc::Sender<ServerMsg>,
        slow: Arc<Notify>,
    ) -> Self {
        Self {
            peer_id,
            node_id,
            tx,
            slow,
        }
    }

    /// Non-blocking enqueue. Returns `true` when the client is considered slow
    /// (queue full / receiver gone) and should be disconnected.
    pub fn send(&self, msg: ServerMsg) -> bool {
        match self.tx.try_send(msg) {
            Ok(()) => false,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.slow.notify_one();
                true
            }
            Err(mpsc::error::TrySendError::Closed(_)) => true,
        }
    }
}

/// Room errors.
#[derive(Debug, Error, PartialEq, Eq, Clone, Copy)]
pub enum RoomError {
    /// The room already exists.
    #[error("房间已存在")]
    Exists,
    /// The room does not exist.
    #[error("房间不存在")]
    NotFound,
    /// The room already holds the maximum number of members.
    #[error("房间已满")]
    Full,
    /// The node has reached `limits.max_rooms`.
    #[error("房间数已达上限")]
    Capacity,
}

/// One room and its members (capacity ≤ 2).
pub struct Room {
    /// Room code.
    pub code: RoomCode,
    /// Members keyed by peer id.
    pub members: HashMap<PeerId, ConnHandle>,
}

impl Room {
    /// Create an empty room.
    pub fn new(code: RoomCode) -> Self {
        Self {
            code,
            members: HashMap::with_capacity(MAX_ROOM_MEMBERS),
        }
    }
}

/// Result of [`RoomTable::leave`].
pub struct LeaveOutcome {
    /// Members still present after the leave (candidates for `peer-left`).
    pub remaining: Vec<ConnHandle>,
    /// Whether the room was destroyed (no members left).
    pub destroyed: bool,
}

/// Sharded room table.
pub struct RoomTable {
    shards: Box<[RwLock<HashMap<RoomCode, Room>>]>,
    room_count: AtomicU64,
    max_rooms: AtomicU64,
}

impl Default for RoomTable {
    fn default() -> Self {
        Self::new(u64::MAX)
    }
}

impl RoomTable {
    /// Create a table with the given room cap.
    pub fn new(max_rooms: u64) -> Self {
        let mut shards = Vec::with_capacity(SHARD_COUNT);
        for _ in 0..SHARD_COUNT {
            shards.push(RwLock::new(HashMap::new()));
        }
        Self {
            shards: shards.into_boxed_slice(),
            room_count: AtomicU64::new(0),
            max_rooms: AtomicU64::new(max_rooms),
        }
    }

    /// Update the room cap (used by hot reload).
    pub fn set_max_rooms(&self, max_rooms: u64) {
        self.max_rooms.store(max_rooms, Ordering::Relaxed);
    }

    /// Create a room owned by `handle`.
    pub fn create(&self, code: RoomCode, handle: ConnHandle) -> Result<(), RoomError> {
        if self.room_count.load(Ordering::Relaxed) >= self.max_rooms.load(Ordering::Relaxed) {
            return Err(RoomError::Capacity);
        }
        let shard = self.shard_mut(&code);
        let mut map = match shard.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if map.contains_key(&code) {
            return Err(RoomError::Exists);
        }
        let mut room = Room::new(code.clone());
        room.members.insert(handle.peer_id.clone(), handle);
        map.insert(code, room);
        self.room_count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Join an existing local room. Returns the members that were already
    /// present (used to broadcast `peer-joined`).
    pub fn join(&self, code: &RoomCode, handle: ConnHandle) -> Result<Vec<ConnHandle>, RoomError> {
        let shard = self.shard_ref(code);
        let mut map = match shard.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let room = map.get_mut(code).ok_or(RoomError::NotFound)?;
        if room.members.len() >= MAX_ROOM_MEMBERS {
            return Err(RoomError::Full);
        }
        let existing: Vec<ConnHandle> = room.members.values().cloned().collect();
        room.members.insert(handle.peer_id.clone(), handle);
        Ok(existing)
    }

    /// Join a room, creating the local entry when it does not exist yet (the
    /// cross-node case: the room exists globally but has no local member).
    pub fn join_or_create(
        &self,
        code: &RoomCode,
        handle: ConnHandle,
    ) -> Result<Vec<ConnHandle>, RoomError> {
        if self.room_count.load(Ordering::Relaxed) >= self.max_rooms.load(Ordering::Relaxed)
            && !self.contains(code)
        {
            return Err(RoomError::Capacity);
        }
        let shard = self.shard_ref(code);
        let mut map = match shard.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match map.get_mut(code) {
            Some(room) => {
                if room.members.len() >= MAX_ROOM_MEMBERS {
                    return Err(RoomError::Full);
                }
                let existing: Vec<ConnHandle> = room.members.values().cloned().collect();
                room.members.insert(handle.peer_id.clone(), handle);
                Ok(existing)
            }
            None => {
                let mut room = Room::new(code.clone());
                room.members.insert(handle.peer_id.clone(), handle);
                map.insert(code.clone(), room);
                self.room_count.fetch_add(1, Ordering::Relaxed);
                Ok(Vec::new())
            }
        }
    }

    /// Handles of every member except `from`.
    pub fn signal_targets(&self, code: &RoomCode, from: &PeerId) -> Vec<ConnHandle> {
        let shard = self.shard_ref(code);
        let map = match shard.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match map.get(code) {
            Some(room) => room
                .members
                .iter()
                .filter(|(id, _)| *id != from)
                .map(|(_, h)| h.clone())
                .collect(),
            None => Vec::new(),
        }
    }

    /// Remove `peer` from `code`.
    pub fn leave(&self, code: &RoomCode, peer: &PeerId) -> LeaveOutcome {
        let shard = self.shard_ref(code);
        let mut map = match shard.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let mut destroyed = false;
        let remaining = match map.get_mut(code) {
            None => Vec::new(),
            Some(room) => {
                room.members.remove(peer);
                if room.members.is_empty() {
                    destroyed = true;
                    Vec::new()
                } else {
                    room.members.values().cloned().collect()
                }
            }
        };
        if destroyed {
            map.remove(code);
            self.room_count.fetch_sub(1, Ordering::Relaxed);
        }
        LeaveOutcome {
            remaining,
            destroyed,
        }
    }

    /// Current room count.
    pub fn len(&self) -> u64 {
        self.room_count.load(Ordering::Relaxed)
    }

    /// `true` when no rooms exist.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether `code` exists locally.
    pub fn contains(&self, code: &RoomCode) -> bool {
        let shard = self.shard_ref(code);
        let map = match shard.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        map.contains_key(code)
    }

    /// Local member count for `code`.
    pub fn len_of(&self, code: &RoomCode) -> usize {
        let shard = self.shard_ref(code);
        let map = match shard.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        map.get(code).map(|r| r.members.len()).unwrap_or(0)
    }

    fn shard_ref(&self, code: &RoomCode) -> &RwLock<HashMap<RoomCode, Room>> {
        &self.shards[shard_index(code)]
    }

    /// Snapshot of every live room code (used by the background TTL
    /// refresher — F4 — which walks the local table off the hot path).
    pub fn room_codes(&self) -> Vec<RoomCode> {
        let mut codes = Vec::with_capacity(self.room_count.load(Ordering::Relaxed) as usize);
        for shard in &self.shards {
            let map = match shard.read() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            codes.extend(map.keys().cloned());
        }
        codes
    }

    fn shard_mut(&self, code: &RoomCode) -> &RwLock<HashMap<RoomCode, Room>> {
        &self.shards[shard_index(code)]
    }
}

/// FNV-1a hash of the code, masked to a shard index.
fn shard_index(code: &RoomCode) -> usize {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in code.as_str().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (hash as usize) & (SHARD_COUNT - 1)
}

/// Callback used by `relay` to deliver a cross-node message to a local peer.
///
/// Defined here (not in `relay`) so `relay` can depend on the abstraction
/// without depending on `transport` — dependency inversion (AGENTS.md §2 D).
pub trait LocalDelivery: Send + Sync {
    /// Deliver `msg` to `target` inside `room` (no-op when absent).
    fn deliver(&self, room: &RoomCode, target: &PeerId, msg: ServerMsg);

    /// Deliver `msg` to every local member of `room`, optionally excluding
    /// `except` (used for cross-node broadcast events: `peer-joined`,
    /// `peer-left`, `signal`).
    fn deliver_others(&self, room: &RoomCode, except: Option<&PeerId>, msg: ServerMsg);
}

impl LocalDelivery for RoomTable {
    fn deliver(&self, room: &RoomCode, target: &PeerId, msg: ServerMsg) {
        let shard = self.shard_ref(room);
        let map = match shard.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(r) = map.get(room) {
            if let Some(handle) = r.members.get(target) {
                handle.send(msg);
            }
        }
    }

    fn deliver_others(&self, room: &RoomCode, except: Option<&PeerId>, msg: ServerMsg) {
        let shard = self.shard_ref(room);
        let map = match shard.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(r) = map.get(room) {
            for (id, handle) in &r.members {
                if except != Some(id) {
                    handle.send(msg.clone());
                }
            }
        }
    }
}

/// Helper: build a bounded outbound channel and a matching slow-notify pair.
pub fn outbound_channel(capacity: usize) -> (mpsc::Sender<ServerMsg>, mpsc::Receiver<ServerMsg>) {
    mpsc::channel(capacity.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(id: &str) -> ConnHandle {
        let (tx, _rx) = outbound_channel(4);
        ConnHandle::new(
            PeerId::new(id).expect("peer id"),
            Arc::from("node-1"),
            tx,
            Arc::new(Notify::new()),
        )
    }

    fn code(s: &str) -> RoomCode {
        RoomCode::new(s).expect("room code")
    }

    #[test]
    fn create_then_create_is_exists() {
        let table = RoomTable::default();
        table
            .create(code("AAAA"), handle("aaaaaaaa"))
            .expect("create");
        assert_eq!(
            table.create(code("AAAA"), handle("bbbbbbbb")),
            Err(RoomError::Exists)
        );
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn join_missing_room_is_not_found() {
        let table = RoomTable::default();
        assert!(matches!(
            table.join(&code("ZZZZ"), handle("aaaaaaaa")),
            Err(RoomError::NotFound)
        ));
    }

    #[test]
    fn join_returns_existing_members_and_full_at_two() {
        let table = RoomTable::default();
        table
            .create(code("AAAA"), handle("aaaaaaaa"))
            .expect("create");
        let existing = table.join(&code("AAAA"), handle("bbbbbbbb")).expect("join");
        assert_eq!(existing.len(), 1);
        assert_eq!(existing[0].peer_id.as_str(), "aaaaaaaa");
        assert!(matches!(
            table.join(&code("AAAA"), handle("cccccccc")),
            Err(RoomError::Full)
        ));
    }

    #[test]
    fn signal_targets_excludes_sender() {
        let table = RoomTable::default();
        table
            .create(code("AAAA"), handle("aaaaaaaa"))
            .expect("create");
        table.join(&code("AAAA"), handle("bbbbbbbb")).expect("join");
        let targets = table.signal_targets(&code("AAAA"), &PeerId::new("aaaaaaaa").expect("id"));
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].peer_id.as_str(), "bbbbbbbb");
    }

    #[test]
    fn signal_targets_empty_for_unknown_room() {
        let table = RoomTable::default();
        let targets = table.signal_targets(&code("AAAA"), &PeerId::new("aaaaaaaa").expect("id"));
        assert!(targets.is_empty());
    }

    #[test]
    fn leave_reports_remaining_and_destroyed() {
        let table = RoomTable::default();
        table
            .create(code("AAAA"), handle("aaaaaaaa"))
            .expect("create");
        table.join(&code("AAAA"), handle("bbbbbbbb")).expect("join");

        let first = table.leave(&code("AAAA"), &PeerId::new("aaaaaaaa").expect("id"));
        assert!(!first.destroyed);
        assert_eq!(first.remaining.len(), 1);
        assert_eq!(table.len(), 1);

        let second = table.leave(&code("AAAA"), &PeerId::new("bbbbbbbb").expect("id"));
        assert!(second.destroyed);
        assert!(second.remaining.is_empty());
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn leave_unknown_room_is_noop() {
        let table = RoomTable::default();
        let outcome = table.leave(&code("AAAA"), &PeerId::new("aaaaaaaa").expect("id"));
        assert!(!outcome.destroyed);
        assert!(outcome.remaining.is_empty());
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn join_or_create_creates_local_entry_for_cross_node_room() {
        let table = RoomTable::default();
        let existing = table
            .join_or_create(&code("AAAA"), handle("aaaaaaaa"))
            .expect("join_or_create");
        assert!(existing.is_empty());
        assert_eq!(table.len(), 1);
        assert!(table.contains(&code("AAAA")));
    }

    #[test]
    fn capacity_is_enforced() {
        let table = RoomTable::new(1);
        table
            .create(code("AAAA"), handle("aaaaaaaa"))
            .expect("create");
        assert_eq!(
            table.create(code("BBBB"), handle("bbbbbbbb")),
            Err(RoomError::Capacity)
        );
    }

    #[test]
    fn local_delivery_reaches_member() {
        let table = RoomTable::default();
        let (tx, mut rx) = outbound_channel(4);
        let h = ConnHandle::new(
            PeerId::new("aaaaaaaa").expect("id"),
            Arc::from("n"),
            tx,
            Arc::new(Notify::new()),
        );
        table.create(code("AAAA"), h).expect("create");
        table.deliver(
            &code("AAAA"),
            &PeerId::new("aaaaaaaa").expect("id"),
            ServerMsg::PeerLeft,
        );
        assert!(rx.try_recv().is_ok());
    }

    /// F4: the TTL refresher walks the local table, so it must be able to
    /// enumerate every live room code across all shards.
    #[test]
    fn room_codes_returns_all_live_rooms() {
        let table = RoomTable::default();
        assert!(table.room_codes().is_empty());
        table
            .create(code("AAAA"), handle("aaaaaaaa"))
            .expect("create");
        table
            .create(code("BBBB"), handle("bbbbbbbb"))
            .expect("create");
        let codes = table.room_codes();
        assert_eq!(codes.len(), 2);
        assert!(codes.contains(&code("AAAA")));
        assert!(codes.contains(&code("BBBB")));
    }
}
