//! Seat bookkeeping: who may come back, when, and with which credential.
//!
//! ## Responsibility boundary
//!
//! * [`RoomTable`](crate::rooms::RoomTable) answers *"who is in which room"*.
//! * [`SeatRegistry`] answers *"who may reclaim a seat, until when, and why"*.
//!
//! ## The core trick (mirrors the Node server, ADR-7)
//!
//! A dropped socket does **not** call `leave`. The room entry and the member
//! handle stay exactly where they are, so "seat preservation" costs nothing:
//! only the grace timer is new. `peer-left` is emitted when (and only when) the
//! grace window expires — that keeps the frozen v1 semantics for old clients.
//!
//! ## Purity
//!
//! This module performs **no IO and reads no clock**: every method takes
//! `now_ms` from the caller and the token source is injectable, so the whole
//! state machine is unit-testable without sleeping or networking.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rand::RngCore;
use subtle::ConstantTimeEq;

use crate::rooms::{PeerId, RoomCode};

/// Entropy of a seat token in bytes (24 bytes → 32 base64url characters).
pub const TOKEN_BYTES: usize = 24;

/// Default grace window (seconds) — mirrors the Node server's `GRACE_SECS`.
pub const DEFAULT_GRACE_SECS: u64 = 60;

/// Which seat a peer holds. The host owns the WebRTC offer side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeatRole {
    /// The peer that created the room (`offerer`).
    Host,
    /// The peer that joined the room (`answerer`).
    Guest,
}

/// One seat: the resumable identity of a player.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seat {
    /// Primary key (the peer id issued on create/join).
    pub peer_id: PeerId,
    /// Room the seat belongs to (denormalised to avoid a reverse lookup).
    pub room: RoomCode,
    /// Display name (already truncated to 20 chars).
    pub name: String,
    /// Host / guest.
    pub role: SeatRole,
    /// Currently valid credential.
    pub token: String,
    /// When the seat entered the grace window; `None` means online.
    pub offline_since_ms: Option<u64>,
    /// Absolute expiry of the grace window; `None` means online.
    pub expires_at_ms: Option<u64>,
    /// Physical connection that currently owns the seat.
    ///
    /// Used to ignore the *late* `close` of a connection that has already been
    /// superseded by a successful `resume` (otherwise the freshly restored seat
    /// would immediately be marked offline again).
    pub owner_conn: u64,
}

impl Seat {
    /// Whether the seat is inside its grace window right now.
    pub fn is_offline(&self) -> bool {
        self.offline_since_ms.is_some()
    }
}

/// Result of [`SeatRegistry::verify`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyResult {
    /// The seat exists, the room matches, the token matches, not expired.
    Ok,
    /// Room mismatch or token mismatch — the credential is not valid.
    Invalid,
    /// The grace window has elapsed.
    Expired,
    /// No such seat.
    Unknown,
}

/// Success payload of atomic [`SeatRegistry::resume`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeSuccess {
    /// Rotated fresh token.
    pub new_token: String,
    /// Player display name.
    pub name: String,
    /// Player seat role (host / guest).
    pub role: SeatRole,
    /// The previous connection ID that owned this seat.
    pub prev_owner_conn: u64,
}

/// Error result of [`SeatRegistry::resume`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResumeError {
    /// Seat does not exist.
    Unknown,
    /// Room mismatch or token mismatch.
    Invalid,
    /// Grace window has expired.
    Expired,
}

/// Thread-safe seat table.
///
/// One `Mutex<HashMap>` (not sharded): a 1v1 room holds at most two seats, and
/// `sweep` must be atomic with respect to `resume` — a single lock makes
/// "sweep decided expired ⇒ resume must fail" trivially true.
pub struct SeatRegistry {
    seats: Mutex<HashMap<PeerId, Seat>>,
    grace_ms: AtomicU64,
    new_token: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Default for SeatRegistry {
    fn default() -> Self {
        Self::new(DEFAULT_GRACE_SECS.saturating_mul(1000))
    }
}

impl SeatRegistry {
    /// Build a registry with a fixed grace window (milliseconds).
    pub fn new(grace_ms: u64) -> Self {
        Self {
            seats: Mutex::new(HashMap::new()),
            grace_ms: AtomicU64::new(grace_ms),
            new_token: Arc::new(new_token),
        }
    }

    /// Build a registry with an injected token source (deterministic tests).
    pub fn with_token_source(grace_ms: u64, source: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        Self {
            seats: Mutex::new(HashMap::new()),
            grace_ms: AtomicU64::new(grace_ms),
            new_token: source,
        }
    }

    /// Current grace window (milliseconds).
    pub fn grace_ms(&self) -> u64 {
        self.grace_ms.load(Ordering::Relaxed)
    }

    /// Grace window in whole seconds (what `peer-offline.graceSec` carries).
    pub fn grace_secs(&self) -> u32 {
        // `grace_ms` is configured in seconds; the conversion is lossless for
        // every sane value and saturates rather than wrapping for absurd ones.
        u32::try_from(self.grace_ms() / 1000).unwrap_or(u32::MAX)
    }

    /// Hot-reload the grace window. Seats already in grace keep their absolute
    /// `expires_at_ms` (no retroactive shortening — that would be a surprise).
    pub fn set_grace_ms(&self, grace_ms: u64) {
        self.grace_ms.store(grace_ms, Ordering::Relaxed);
    }

    /// Register (or overwrite) the seat of `peer_id` and return a fresh token.
    ///
    /// Called on `create` / `join` success. Re-registering the same peer (room
    /// switch) overwrites the old seat.
    pub fn issue(
        &self,
        peer_id: &PeerId,
        room: &RoomCode,
        name: &str,
        role: SeatRole,
        owner_conn: u64,
        _now_ms: u64,
    ) -> String {
        let token = (self.new_token)();
        let seat = Seat {
            peer_id: peer_id.clone(),
            room: room.clone(),
            name: name.to_string(),
            role,
            token: token.clone(),
            offline_since_ms: None,
            expires_at_ms: None,
            owner_conn,
        };
        let mut seats = self.lock();
        seats.insert(peer_id.clone(), seat);
        token
    }

    /// Mark a seat as offline (called when the socket drops).
    ///
    /// **Idempotent**: a seat already inside its grace window returns `None`,
    /// so the caller broadcasts `peer-offline` exactly once per window.
    pub fn mark_offline(&self, peer_id: &PeerId, now_ms: u64) -> Option<Seat> {
        let mut seats = self.lock();
        let seat = seats.get_mut(peer_id)?;
        if seat.offline_since_ms.is_some() {
            return None;
        }
        seat.offline_since_ms = Some(now_ms);
        seat.expires_at_ms = Some(now_ms.saturating_add(self.grace_ms()));
        Some(seat.clone())
    }

    /// Verify a `resume` request.
    ///
    /// The check order is fixed — unknown → room → token → expiry — so the
    /// failure reason cannot be used as an oracle for a seat's existence.
    pub fn verify(
        &self,
        peer_id: &PeerId,
        room: &RoomCode,
        token: &str,
        now_ms: u64,
    ) -> VerifyResult {
        let seats = self.lock();
        let Some(seat) = seats.get(peer_id) else {
            return VerifyResult::Unknown;
        };
        if &seat.room != room {
            return VerifyResult::Invalid;
        }
        if !token_equals(&seat.token, token) {
            return VerifyResult::Invalid;
        }
        if let Some(expires_at) = seat.expires_at_ms {
            if now_ms >= expires_at {
                return VerifyResult::Expired;
            }
        }
        VerifyResult::Ok
    }

    /// Check whether a seat is registered locally.
    pub fn contains(&self, peer_id: &PeerId) -> bool {
        self.lock().contains_key(peer_id)
    }

    /// Generate a fresh token using this registry's token generator.
    pub fn generate_token(&self) -> String {
        (self.new_token)()
    }

    /// Install a seat directly (used during cross-node takeover).
    pub fn install_seat(&self, seat: Seat) {
        let mut seats = self.lock();
        seats.insert(seat.peer_id.clone(), seat);
    }

    /// Atomically verify and resume a seat (Issue 1).
    ///
    /// Performs token verification, expiry check, token rotation, clearing the
    /// offline grace window, and updating the owner connection id under a single
    /// mutex lock.
    ///
    /// This eliminates the race condition where multiple concurrent requests
    /// present the same token and both pass verification before rotation.
    pub fn resume(
        &self,
        peer_id: &PeerId,
        room: &RoomCode,
        token: &str,
        new_owner_conn: u64,
        now_ms: u64,
    ) -> Result<ResumeSuccess, ResumeError> {
        let mut seats = self.lock();
        let Some(seat) = seats.get_mut(peer_id) else {
            return Err(ResumeError::Unknown);
        };
        if &seat.room != room {
            return Err(ResumeError::Invalid);
        }
        if !token_equals(&seat.token, token) {
            return Err(ResumeError::Invalid);
        }
        if let Some(expires_at) = seat.expires_at_ms {
            if now_ms >= expires_at {
                return Err(ResumeError::Expired);
            }
        }
        let prev_owner = seat.owner_conn;
        let new_token = (self.new_token)();
        seat.token = new_token.clone();
        seat.offline_since_ms = None;
        seat.expires_at_ms = None;
        seat.owner_conn = new_owner_conn;
        Ok(ResumeSuccess {
            new_token,
            name: seat.name.clone(),
            role: seat.role,
            prev_owner_conn: prev_owner,
        })
    }

    /// Rotate the credential and put the seat back online (after a successful
    /// `resume`). The previous token stops working immediately (anti-replay).
    pub fn rotate(&self, peer_id: &PeerId, owner_conn: u64, _now_ms: u64) -> Option<String> {
        let mut seats = self.lock();
        let seat = seats.get_mut(peer_id)?;
        let token = (self.new_token)();
        seat.token = token.clone();
        seat.offline_since_ms = None;
        seat.expires_at_ms = None;
        seat.owner_conn = owner_conn;
        Some(token)
    }

    /// Drop the seat immediately (explicit `leave`, or after the sweep).
    pub fn release(&self, peer_id: &PeerId) -> Option<Seat> {
        self.lock().remove(peer_id)
    }

    /// Collect every seat whose grace window has elapsed, removing them.
    ///
    /// The caller is responsible for `leave` + broadcasting `peer-left`.
    pub fn sweep(&self, now_ms: u64) -> Vec<Seat> {
        let mut seats = self.lock();
        let expired: Vec<PeerId> = seats
            .values()
            .filter(|seat| {
                seat.expires_at_ms
                    .map(|expires_at| now_ms >= expires_at)
                    .unwrap_or(false)
            })
            .map(|seat| seat.peer_id.clone())
            .collect();
        expired
            .into_iter()
            .filter_map(|peer| seats.remove(&peer))
            .collect()
    }

    /// Read-only snapshot of a seat (diagnostics; never used for verification).
    pub fn peek(&self, peer_id: &PeerId) -> Option<Seat> {
        self.lock().get(peer_id).cloned()
    }

    /// Whether `conn_id` is the connection that currently owns the seat.
    ///
    /// A stale connection's late `close` must not push a restored seat back
    /// into the grace window.
    pub fn is_owner(&self, peer_id: &PeerId, conn_id: u64) -> bool {
        self.lock()
            .get(peer_id)
            .map(|seat| seat.owner_conn == conn_id)
            .unwrap_or(false)
    }

    /// Number of seats (online + in grace).
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Whether the table is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PeerId, Seat>> {
        match self.seats.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// Spawn the background seat sweeper task.
///
/// Every `cfg.session.sweep_interval_secs` (supporting dynamic hot-reload),
/// any seat whose grace period has expired is swept and leaves the room
/// (broadcasting `peer-left`).
pub fn spawn_sweeper(
    deps: super::ConnDeps,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let interval_secs = deps.cfg.snapshot().session.sweep_interval_secs.max(1);
            tokio::select! {
                biased;
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval_secs)) => {
                    let now = super::heartbeat::now_ms();
                    let expired = deps.seats.sweep(now);
                    for seat in expired {
                        tracing::info!(
                            node_id = %deps.node_id,
                            peer_id = %seat.peer_id,
                            room = %seat.room,
                            grace_ms = deps.seats.grace_ms(),
                            "srv.grace.expire"
                        );
                        super::router::do_leave(&deps, &seat.peer_id, &seat.room).await;
                    }
                }
            }
        }
    })
}

/// Generate a fresh seat token: 24 random bytes, base64url without padding
/// (32 characters, ≥ 144 bits of entropy).
pub fn new_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64url(&bytes)
}

/// Constant-time credential comparison.
///
/// Length mismatch short-circuits (the length is not a secret: tokens are a
/// fixed 32 characters); equal-length comparison is branch-free.
pub fn token_equals(a: &str, b: &str) -> bool {
    let left = a.as_bytes();
    let right = b.as_bytes();
    if left.is_empty() || left.len() != right.len() {
        return false;
    }
    left.ct_eq(right).into()
}

/// base64url (RFC 4648 §5) without padding.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).map(|b| u32::from(*b)).unwrap_or(0);
        let b2 = chunk.get(2).map(|b| u32::from(*b)).unwrap_or(0);
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(char::from(ALPHABET[((triple >> 18) & 0x3f) as usize]));
        out.push(char::from(ALPHABET[((triple >> 12) & 0x3f) as usize]));
        if chunk.len() > 1 {
            out.push(char::from(ALPHABET[((triple >> 6) & 0x3f) as usize]));
        }
        if chunk.len() > 2 {
            out.push(char::from(ALPHABET[(triple & 0x3f) as usize]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str) -> PeerId {
        PeerId::new(id).expect("peer id")
    }

    fn room(code: &str) -> RoomCode {
        RoomCode::new(code).expect("room code")
    }

    fn fixed(source: &'static str) -> SeatRegistry {
        SeatRegistry::with_token_source(60_000, Arc::new(move || source.to_string()))
    }

    #[test]
    fn issue_stores_the_seat_and_returns_a_token() {
        let seats = SeatRegistry::new(60_000);
        let token = seats.issue(
            &peer("aaaaaaaa"),
            &room("ABCD"),
            "小明",
            SeatRole::Host,
            1,
            0,
        );
        assert_eq!(token.len(), 32);
        assert!(token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        let seat = seats.peek(&peer("aaaaaaaa")).expect("seat");
        assert_eq!(seat.room, room("ABCD"));
        assert_eq!(seat.name, "小明");
        assert_eq!(seat.role, SeatRole::Host);
        assert_eq!(seat.owner_conn, 1);
        assert!(!seat.is_offline());
        assert_eq!(seats.len(), 1);
    }

    #[test]
    fn base64url_matches_known_vectors() {
        // RFC 4648 test vectors, URL-safe alphabet, no padding.
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(b"fooba"), "Zm9vYmE");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        // Bytes that map to `-` and `_` in the URL-safe alphabet.
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn tokens_are_unique_and_32_chars() {
        let seats = SeatRegistry::new(60_000);
        let a = seats.issue(&peer("aaaaaaaa"), &room("ABCD"), "", SeatRole::Host, 1, 0);
        let b = seats.issue(&peer("bbbbbbbb"), &room("ABCD"), "", SeatRole::Guest, 2, 0);
        assert_eq!(a.len(), 32);
        assert_eq!(b.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn verify_rejects_unknown_room_and_token_in_order() {
        let seats = fixed("tok");
        seats.issue(&peer("aaaaaaaa"), &room("ABCD"), "", SeatRole::Host, 1, 0);

        assert_eq!(
            seats.verify(&peer("zzzzzzzz"), &room("ABCD"), "tok", 0),
            VerifyResult::Unknown
        );
        assert_eq!(
            seats.verify(&peer("aaaaaaaa"), &room("WXYZ"), "tok", 0),
            VerifyResult::Invalid
        );
        assert_eq!(
            seats.verify(&peer("aaaaaaaa"), &room("ABCD"), "nope", 0),
            VerifyResult::Invalid
        );
        assert_eq!(
            seats.verify(&peer("aaaaaaaa"), &room("ABCD"), "", 0),
            VerifyResult::Invalid
        );
        assert_eq!(
            seats.verify(&peer("aaaaaaaa"), &room("ABCD"), "tok", 0),
            VerifyResult::Ok
        );
    }

    #[test]
    fn grace_boundary_is_inclusive_at_expiry() {
        let seats = fixed("tok");
        let peer = peer("aaaaaaaa");
        seats.issue(&peer, &room("ABCD"), "", SeatRole::Host, 1, 1_000);
        seats.mark_offline(&peer, 1_000).expect("first offline");

        // 59_999 ms after entering grace → still resumable.
        assert_eq!(
            seats.verify(&peer, &room("ABCD"), "tok", 60_999),
            VerifyResult::Ok
        );
        // Exactly 60_000 ms → expired.
        assert_eq!(
            seats.verify(&peer, &room("ABCD"), "tok", 61_000),
            VerifyResult::Expired
        );
    }

    #[test]
    fn mark_offline_is_idempotent() {
        let seats = fixed("tok");
        let p = peer("aaaaaaaa");
        seats.issue(&p, &room("ABCD"), "", SeatRole::Host, 1, 0);
        assert!(seats.mark_offline(&p, 1_000).is_some());
        assert!(seats.mark_offline(&p, 2_000).is_none());
        // The window still ends 60s after the *first* offline mark.
        assert_eq!(
            seats.verify(&p, &room("ABCD"), "tok", 61_000),
            VerifyResult::Expired
        );
        // Unknown seats are never marked.
        assert!(seats.mark_offline(&peer("zzzzzzzz"), 1_000).is_none());
    }

    #[test]
    fn rotate_invalidates_the_old_token_and_clears_grace() {
        let seats = SeatRegistry::new(60_000);
        let p = peer("aaaaaaaa");
        let first = seats.issue(&p, &room("ABCD"), "", SeatRole::Host, 1, 0);
        seats.mark_offline(&p, 1_000).expect("offline");

        let rotated = seats.rotate(&p, 2, 2_000).expect("rotate");
        assert_ne!(rotated, first);
        assert_eq!(
            seats.verify(&p, &room("ABCD"), &first, 2_000),
            VerifyResult::Invalid
        );
        assert_eq!(
            seats.verify(&p, &room("ABCD"), &rotated, 2_000),
            VerifyResult::Ok
        );
        let seat = seats.peek(&p).expect("seat");
        assert!(!seat.is_offline());
        assert_eq!(seat.owner_conn, 2);
        // Unknown seat cannot rotate.
        assert!(seats.rotate(&peer("zzzzzzzz"), 2, 2_000).is_none());
    }

    #[test]
    fn sweep_returns_each_expired_seat_once() {
        let seats = fixed("tok");
        let a = peer("aaaaaaaa");
        let b = peer("bbbbbbbb");
        seats.issue(&a, &room("ABCD"), "", SeatRole::Host, 1, 0);
        seats.issue(&b, &room("ABCD"), "", SeatRole::Guest, 2, 0);
        seats.mark_offline(&a, 0).expect("offline a");
        // `b` stays online and must never be swept.
        assert!(seats.sweep(59_999).is_empty());
        let expired = seats.sweep(60_000);
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].peer_id, a);
        assert!(seats.sweep(120_000).is_empty());
        assert_eq!(seats.len(), 1);
        assert!(seats.peek(&b).is_some());
    }

    #[test]
    fn release_drops_the_seat() {
        let seats = fixed("tok");
        let peer = peer("aaaaaaaa");
        seats.issue(&peer, &room("ABCD"), "", SeatRole::Host, 1, 0);
        assert!(seats.release(&peer).is_some());
        assert!(seats.peek(&peer).is_none());
        assert_eq!(
            seats.verify(&peer, &room("ABCD"), "tok", 0),
            VerifyResult::Unknown
        );
    }

    #[test]
    fn ownership_follows_rotate() {
        let seats = fixed("tok");
        let peer = peer("aaaaaaaa");
        seats.issue(&peer, &room("ABCD"), "", SeatRole::Host, 7, 0);
        assert!(seats.is_owner(&peer, 7));
        assert!(!seats.is_owner(&peer, 8));
        seats.rotate(&peer, 8, 1).expect("rotate");
        assert!(!seats.is_owner(&peer, 7));
        assert!(seats.is_owner(&peer, 8));
    }

    #[test]
    fn grace_secs_is_reported_for_the_wire() {
        let seats = SeatRegistry::new(60_000);
        assert_eq!(seats.grace_secs(), 60);
        seats.set_grace_ms(1_500);
        assert_eq!(seats.grace_secs(), 1);
    }

    #[test]
    fn token_equals_is_length_and_content_sensitive() {
        assert!(token_equals("abc", "abc"));
        assert!(!token_equals("abc", "abd"));
        assert!(!token_equals("abc", "abcd"));
        assert!(!token_equals("", ""));
    }

    #[test]
    fn concurrent_resumes_only_one_succeeds() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::thread;

        let seats = Arc::new(SeatRegistry::default());
        let p = peer("aaaaaaaa");
        let r = room("ABCD");
        let token = seats.issue(&p, &r, "Player1", SeatRole::Host, 1, 0);
        seats.mark_offline(&p, 0);

        let successes = Arc::new(AtomicUsize::new(0));
        let invalids = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();

        for i in 0..50 {
            let seats = seats.clone();
            let p = p.clone();
            let r = r.clone();
            let token = token.clone();
            let successes = successes.clone();
            let invalids = invalids.clone();
            handles.push(thread::spawn(move || {
                match seats.resume(&p, &r, &token, 100 + i, 10) {
                    Ok(_) => {
                        successes.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(ResumeError::Invalid) => {
                        invalids.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(other) => panic!("unexpected error: {other:?}"),
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(successes.load(Ordering::SeqCst), 1);
        assert_eq!(invalids.load(Ordering::SeqCst), 49);
    }
}
