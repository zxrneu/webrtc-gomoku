//! Cross-module integration test for the sharded room state machine (T05).
//!
//! Exercises `RoomTable` exactly as `transport::router` drives it: create /
//! join / signal / leave, every error branch, and local delivery of
//! `peer-joined` / `peer-left` / `signal`.

use std::sync::Arc;

use gomoku_signaling::protocol::{messages, ServerMsg};
use gomoku_signaling::rooms::{
    is_valid_peer_id, is_valid_room_code, outbound_channel, ConnHandle, LocalDelivery, PeerId,
    RoomCode, RoomError, RoomTable,
};
use tokio::sync::mpsc;
use tokio::sync::Notify;

/// A test handle plus the receiver its outbound queue writes to.
fn handle(id: &str, node: &str) -> (ConnHandle, mpsc::Receiver<ServerMsg>) {
    let (tx, rx) = outbound_channel(16);
    let handle = ConnHandle::new(
        PeerId::new(id).expect("peer id"),
        Arc::from(node),
        tx,
        Arc::new(Notify::new()),
    );
    (handle, rx)
}

fn code(s: &str) -> RoomCode {
    RoomCode::new(s).expect("room code")
}

fn peer(s: &str) -> PeerId {
    PeerId::new(s).expect("peer id")
}

#[test]
fn create_then_duplicate_create_is_exists() {
    let table = RoomTable::default();
    let (a, _ra) = handle("aaaaaaaa", "n1");
    table.create(code("AB12"), a).expect("create");
    assert_eq!(table.len(), 1);

    let (b, _rb) = handle("bbbbbbbb", "n1");
    assert!(matches!(
        table.create(code("AB12"), b),
        Err(RoomError::Exists)
    ));
    assert_eq!(table.len(), 1, "a failed create must not leak a room");
}

#[test]
fn join_missing_room_is_not_found() {
    let table = RoomTable::default();
    let (b, _rb) = handle("bbbbbbbb", "n1");
    assert!(matches!(
        table.join(&code("ZZ99"), b),
        Err(RoomError::NotFound)
    ));
}

#[test]
fn join_returns_existing_members_then_is_full_at_two() {
    let table = RoomTable::default();
    let (a, _ra) = handle("aaaaaaaa", "n1");
    table.create(code("AB12"), a).expect("create");

    let (b, _rb) = handle("bbbbbbbb", "n1");
    let existing = table.join(&code("AB12"), b).expect("join");
    assert_eq!(existing.len(), 1);
    assert_eq!(existing[0].peer_id.as_str(), "aaaaaaaa");

    let (c, _rc) = handle("cccccccc", "n1");
    assert!(matches!(table.join(&code("AB12"), c), Err(RoomError::Full)));
}

#[test]
fn leave_reports_remaining_and_destroyed_and_reclaims_the_room() {
    let table = RoomTable::default();
    let (a, _ra) = handle("aaaaaaaa", "n1");
    let (b, _rb) = handle("bbbbbbbb", "n1");
    table.create(code("AB12"), a).expect("create");
    table.join(&code("AB12"), b).expect("join");

    let first = table.leave(&code("AB12"), &peer("aaaaaaaa"));
    assert!(!first.destroyed);
    assert_eq!(first.remaining.len(), 1);
    assert_eq!(first.remaining[0].peer_id.as_str(), "bbbbbbbb");
    assert_eq!(table.len(), 1);

    let second = table.leave(&code("AB12"), &peer("bbbbbbbb"));
    assert!(second.destroyed);
    assert!(second.remaining.is_empty());
    assert_eq!(table.len(), 0);
    assert!(!table.contains(&code("AB12")));
}

#[test]
fn leave_unknown_room_is_a_noop() {
    let table = RoomTable::default();
    let outcome = table.leave(&code("AB12"), &peer("aaaaaaaa"));
    assert!(!outcome.destroyed);
    assert!(outcome.remaining.is_empty());
    assert_eq!(table.len(), 0);
}

#[test]
fn signal_targets_excludes_the_sender() {
    let table = RoomTable::default();
    let (a, _ra) = handle("aaaaaaaa", "n1");
    let (b, _rb) = handle("bbbbbbbb", "n1");
    table.create(code("AB12"), a).expect("create");
    table.join(&code("AB12"), b).expect("join");

    let from_a = table.signal_targets(&code("AB12"), &peer("aaaaaaaa"));
    assert_eq!(from_a.len(), 1);
    assert_eq!(from_a[0].peer_id.as_str(), "bbbbbbbb");

    let from_b = table.signal_targets(&code("AB12"), &peer("bbbbbbbb"));
    assert_eq!(from_b.len(), 1);
    assert_eq!(from_b[0].peer_id.as_str(), "aaaaaaaa");

    // Unknown room → no targets.
    assert!(table
        .signal_targets(&code("ZZ99"), &peer("aaaaaaaa"))
        .is_empty());
}

#[test]
fn capacity_is_enforced_per_node() {
    let table = RoomTable::new(1);
    let (a, _ra) = handle("aaaaaaaa", "n1");
    table.create(code("AB12"), a).expect("create");

    let (b, _rb) = handle("bbbbbbbb", "n1");
    assert!(matches!(
        table.create(code("CD34"), b),
        Err(RoomError::Capacity)
    ));

    // Lowering the cap via reload takes effect immediately.
    table.set_max_rooms(0);
    let (c, _rc) = handle("cccccccc", "n1");
    assert!(matches!(
        table.create(code("EF56"), c),
        Err(RoomError::Capacity)
    ));
}

#[test]
fn join_or_create_creates_the_local_entry_for_a_cross_node_room() {
    let table = RoomTable::default();
    let (b, _rb) = handle("bbbbbbbb", "n1");
    let existing = table
        .join_or_create(&code("AB12"), b)
        .expect("join_or_create");
    assert!(existing.is_empty(), "no local peer existed yet");
    assert_eq!(table.len(), 1);
    assert!(table.contains(&code("AB12")));
    assert_eq!(table.len_of(&code("AB12")), 1);
}

#[test]
fn local_delivery_delivers_to_a_specific_member() {
    let table = RoomTable::default();
    let (a, mut ra) = handle("aaaaaaaa", "n1");
    let (b, mut rb) = handle("bbbbbbbb", "n1");
    table.create(code("AB12"), a).expect("create");
    table.join(&code("AB12"), b).expect("join");

    table.deliver(&code("AB12"), &peer("bbbbbbbb"), messages::peer_left());
    assert_eq!(
        rb.try_recv().expect("b received"),
        ServerMsg::PeerLeft { role: None }
    );
    assert!(
        ra.try_recv().is_err(),
        "a must not receive a targeted message"
    );
}

#[test]
fn local_delivery_broadcasts_to_others() {
    let table = RoomTable::default();
    let (a, mut ra) = handle("aaaaaaaa", "n1");
    let (b, mut rb) = handle("bbbbbbbb", "n1");
    table.create(code("AB12"), a).expect("create");
    table.join(&code("AB12"), b).expect("join");

    // Broadcast a `peer-joined` (as a cross-node subscriber would).
    table.deliver_others(
        &code("AB12"),
        Some(&peer("cccccccc")),
        messages::peer_joined("cccccccc", "小明"),
    );
    let got_a = ra.try_recv().expect("a received");
    let got_b = rb.try_recv().expect("b received");
    assert_eq!(got_a, messages::peer_joined("cccccccc", "小明"));
    assert_eq!(got_b, got_a);

    // Excluding an actual local member skips it.
    table.deliver_others(
        &code("AB12"),
        Some(&peer("aaaaaaaa")),
        messages::peer_left(),
    );
    assert_eq!(
        rb.try_recv().expect("b received"),
        ServerMsg::PeerLeft { role: None }
    );
    assert!(ra.try_recv().is_err(), "a was excluded");
}

#[test]
fn room_code_is_uppercased_and_format_validated() {
    assert_eq!(RoomCode::new("ab12").expect("ok").as_str(), "AB12");
    assert_eq!(RoomCode::new("aB1z").expect("ok").as_str(), "AB1Z");
    for bad in ["", "ABC", "ABCDE", "AB-2", "汉字AB", "ab 2"] {
        assert!(RoomCode::new(bad).is_err(), "should reject {bad:?}");
    }
}

#[test]
fn peer_id_format_is_lowercase_base36_of_length_eight() {
    assert!(PeerId::new("abcdefgh").is_ok());
    assert!(PeerId::new("01234567").is_ok());
    assert!(PeerId::new("ABCD1234").is_err(), "uppercase is rejected");
    assert!(PeerId::new("abc").is_err(), "too short");
    assert!(PeerId::new("abcdefghi").is_err(), "too long");

    for _ in 0..200 {
        let id = gomoku_signaling::rooms::generate_peer_id();
        assert!(is_valid_peer_id(id.as_str()));
    }
    for _ in 0..200 {
        let c = gomoku_signaling::rooms::generate_room_code();
        assert!(is_valid_room_code(c.as_str()));
    }
}
