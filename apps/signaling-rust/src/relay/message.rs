//! Cross-node message body (Redis pub/sub payload).

use serde::{Deserialize, Serialize};

use crate::rooms::{PeerId, RoomCode};

/// Current cross-node protocol version.
pub const PROTOCOL_VERSION: u8 = 1;

/// The kind of cross-node event.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CrossKind {
    /// A peer joined the room.
    PeerJoined,
    /// A peer left the room.
    PeerLeft,
    /// An opaque signaling payload.
    Signal,
}

/// A message exchanged between nodes through the per-room pub/sub channel.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CrossNodeMsg {
    /// Protocol version (always [`PROTOCOL_VERSION`]).
    pub v: u8,
    /// 4-char room code.
    pub room: String,
    /// Sending node id.
    pub from_node: String,
    /// Sending peer id.
    pub from_peer: String,
    /// Event kind.
    pub kind: CrossKind,
    /// Target peer id (`None` = broadcast to the room's other members).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Display name (only for `peer-joined`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Opaque signaling payload (only for `signal`; never inspected here).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

impl CrossNodeMsg {
    /// Build a message for `kind` originating from `from_peer@from_node`.
    pub fn new(kind: CrossKind, room: &RoomCode, from_node: &str, from_peer: &PeerId) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            room: room.as_str().to_string(),
            from_node: from_node.to_string(),
            from_peer: from_peer.as_str().to_string(),
            kind,
            target: None,
            name: None,
            payload: None,
        }
    }

    /// Attach a display name.
    pub fn with_name(mut self, name: &str) -> Self {
        self.name = Some(name.to_string());
        self
    }

    /// Attach an opaque signaling payload.
    pub fn with_payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = Some(payload);
        self
    }

    /// Attach an explicit target peer id.
    pub fn with_target(mut self, target: &PeerId) -> Self {
        self.target = Some(target.as_str().to_string());
        self
    }

    /// Serialize to JSON.
    pub fn encode(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Parse from JSON.
    pub fn decode(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(s: &str) -> RoomCode {
        RoomCode::new(s).expect("code")
    }

    fn peer(s: &str) -> PeerId {
        PeerId::new(s).expect("peer")
    }

    #[test]
    fn signal_roundtrip_is_lossless() {
        let msg = CrossNodeMsg::new(
            CrossKind::Signal,
            &code("ABCD"),
            "node-1",
            &peer("aaaaaaaa"),
        )
        .with_payload(serde_json::json!({"kind":"offer","sdp":"v=0"}));
        let encoded = msg.encode().expect("encode");
        let decoded = CrossNodeMsg::decode(&encoded).expect("decode");
        assert_eq!(msg, decoded);
        assert_eq!(decoded.v, PROTOCOL_VERSION);
        assert_eq!(decoded.kind, CrossKind::Signal);
    }

    #[test]
    fn peer_joined_roundtrip_keeps_name() {
        let msg = CrossNodeMsg::new(
            CrossKind::PeerJoined,
            &code("WXYZ"),
            "node-2",
            &peer("bbbbbbbb"),
        )
        .with_name("小明");
        let decoded = CrossNodeMsg::decode(&msg.encode().expect("encode")).expect("decode");
        assert_eq!(decoded.name.as_deref(), Some("小明"));
        assert_eq!(decoded.kind, CrossKind::PeerJoined);
    }

    #[test]
    fn absent_optionals_are_omitted() {
        let msg = CrossNodeMsg::new(CrossKind::PeerLeft, &code("ABCD"), "n", &peer("aaaaaaaa"));
        let encoded = msg.encode().expect("encode");
        assert!(!encoded.contains("name"));
        assert!(!encoded.contains("payload"));
        assert!(!encoded.contains("target"));
        assert!(encoded.contains("\"kind\":\"peer-left\""));
    }

    #[test]
    fn kind_serializes_kebab_case() {
        let msg = CrossNodeMsg::new(CrossKind::PeerJoined, &code("ABCD"), "n", &peer("aaaaaaaa"));
        assert!(msg.encode().expect("encode").contains("\"peer-joined\""));
    }
}
