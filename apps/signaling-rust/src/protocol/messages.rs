//! Frozen error strings and server-message constructors.
//!
//! All client-visible error text lives here so it can never drift from v1
//! (PRD §4.5). Hot-path code must not hard-code these literals elsewhere.

use crate::protocol::ServerMsg;

/// `create` with a provided but malformed room code.
pub const ERR_ROOM_FORMAT: &str = "房间号需为 4 位字母或数字";
/// `join` / `signal` when the room does not exist (code is interpolated).
pub const ERR_ROOM_NOT_FOUND_PREFIX: &str = "房间 ";
/// `join` / `signal` when the room does not exist (suffix is interpolated).
pub const ERR_ROOM_NOT_FOUND_SUFFIX: &str = " 不存在";
/// `create` when the room already exists (code is interpolated).
pub const ERR_ROOM_EXISTS_PREFIX: &str = "房间 ";
/// `create` when the room already exists (suffix is interpolated).
pub const ERR_ROOM_EXISTS_SUFFIX: &str = " 已存在，请更换";
/// `join` when the room already holds two peers.
pub const ERR_ROOM_FULL: &str = "房间已满（仅支持 1v1）";
/// An unknown `t` value.
pub const ERR_UNKNOWN_TYPE: &str = "未知消息类型";
/// `resume` when the seat is gone / the grace window has expired (v1.1).
pub const ERR_RESUME_REJECTED: &str = "房间已失效，请重新加入";
/// `resume` when the credential does not match (v1.1).
pub const ERR_RESUME_TOKEN_INVALID: &str = "座位凭证无效";
/// Load-shedding / internal error (reached only when the node is at
/// `limits.max_rooms` or code generation exhausts its retries). Not part of the
/// frozen v1 error set — it never occurs in normal operation.
pub const ERR_SERVER_BUSY: &str = "服务器繁忙，请稍后再试";

/// Machine-readable error codes (v1.1, `ServerErrorCode` in `types.ts`).
///
/// Every string is part of the wire contract — never rename one.
pub mod code {
    /// Malformed room code.
    pub const ROOM_FORMAT: &str = "ROOM_FORMAT";
    /// Room already exists.
    pub const ROOM_EXISTS: &str = "ROOM_EXISTS";
    /// Room does not exist.
    pub const ROOM_NOT_FOUND: &str = "ROOM_NOT_FOUND";
    /// Room already holds two peers.
    pub const ROOM_FULL: &str = "ROOM_FULL";
    /// Unknown `t`.
    pub const UNKNOWN_TYPE: &str = "UNKNOWN_TYPE";
    /// The seat cannot be reclaimed (unknown / expired).
    pub const RESUME_REJECTED: &str = "RESUME_REJECTED";
    /// The credential does not match.
    pub const RESUME_TOKEN_INVALID: &str = "RESUME_TOKEN_INVALID";
}

/// Maximum display-name length (Unicode scalar values).
pub const NAME_MAX_CHARS: usize = 20;

/// Last-resort JSON emitted if serialization ever fails (it cannot for these
/// variants, but the hot path must never panic).
pub(crate) const ENCODE_FALLBACK: &str = r#"{"t":"error","message":"内部错误"}"#;

/// Build the "room already exists" error text for `code`.
pub fn err_room_exists(code: &str) -> String {
    format!("{ERR_ROOM_EXISTS_PREFIX}{code}{ERR_ROOM_EXISTS_SUFFIX}")
}

/// Build the "room not found" error text for `code`.
pub fn err_room_not_found(code: &str) -> String {
    format!("{ERR_ROOM_NOT_FOUND_PREFIX}{code}{ERR_ROOM_NOT_FOUND_SUFFIX}")
}

/// `{t:'created', room, peerId}`
pub fn created(room: &str, peer_id: &str) -> ServerMsg {
    ServerMsg::Created {
        room: room.to_string(),
        peer_id: peer_id.to_string(),
        token: None,
    }
}

/// `{t:'created', room, peerId, token}` (v1.1)
pub fn created_with_token(room: &str, peer_id: &str, token: &str) -> ServerMsg {
    ServerMsg::Created {
        room: room.to_string(),
        peer_id: peer_id.to_string(),
        token: Some(token.to_string()),
    }
}

/// `{t:'joined', room, peerId}`
pub fn joined(room: &str, peer_id: &str) -> ServerMsg {
    ServerMsg::Joined {
        room: room.to_string(),
        peer_id: peer_id.to_string(),
        token: None,
    }
}

/// `{t:'joined', room, peerId, token}` (v1.1)
pub fn joined_with_token(room: &str, peer_id: &str, token: &str) -> ServerMsg {
    ServerMsg::Joined {
        room: room.to_string(),
        peer_id: peer_id.to_string(),
        token: Some(token.to_string()),
    }
}

/// `{t:'peer-joined', peerId, name}`
pub fn peer_joined(peer_id: &str, name: &str) -> ServerMsg {
    ServerMsg::PeerJoined {
        peer_id: peer_id.to_string(),
        name: name.to_string(),
    }
}

/// `{t:'peer-left'}`
pub fn peer_left() -> ServerMsg {
    ServerMsg::PeerLeft { role: None }
}

/// Notify the survivor of its server-confirmed role.
pub fn peer_left_with_role(role: &str) -> ServerMsg {
    ServerMsg::PeerLeft {
        role: Some(role.to_string()),
    }
}

/// `{t:'signal', data}`
pub fn signal(data: serde_json::Value) -> ServerMsg {
    ServerMsg::Signal { data }
}

/// `{t:'error', message}` (no machine-readable code — the v1 shape).
pub fn error(message: impl Into<String>) -> ServerMsg {
    ServerMsg::Error {
        message: message.into(),
        code: None,
    }
}

/// `{t:'error', message, code}` (v1.1: the message stays byte-identical, the
/// code is *appended*).
pub fn error_with_code(message: impl Into<String>, code: &str) -> ServerMsg {
    ServerMsg::Error {
        message: message.into(),
        code: Some(code.to_string()),
    }
}

/// `{t:'pong', ts?}`
pub fn pong(ts: Option<f64>) -> ServerMsg {
    ServerMsg::Pong { ts }
}

/// `{t:'peer-offline', graceSec}`
pub fn peer_offline(grace_sec: u32) -> ServerMsg {
    ServerMsg::PeerOffline { grace_sec }
}

/// `{t:'peer-online'}`
pub fn peer_online() -> ServerMsg {
    ServerMsg::PeerOnline
}

/// `{t:'resumed', room, peerId, token, peerPresent?}`
pub fn resumed(
    room: &str,
    peer_id: &str,
    token: &str,
    peer_present: impl Into<Option<bool>>,
) -> ServerMsg {
    ServerMsg::Resumed {
        room: room.to_string(),
        peer_id: peer_id.to_string(),
        token: token.to_string(),
        peer_present: peer_present.into(),
        role: None,
    }
}

/// Resume a seat with its persisted role without changing the legacy constructor.
pub fn resumed_with_role(
    room: &str,
    peer_id: &str,
    token: &str,
    peer_present: impl Into<Option<bool>>,
    role: &str,
) -> ServerMsg {
    let mut msg = resumed(room, peer_id, token, peer_present);
    if let ServerMsg::Resumed {
        role: confirmed, ..
    } = &mut msg
    {
        *confirmed = Some(role.to_string());
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_texts_match_v1_verbatim() {
        assert_eq!(ERR_ROOM_FORMAT, "房间号需为 4 位字母或数字");
        assert_eq!(ERR_ROOM_FULL, "房间已满（仅支持 1v1）");
        assert_eq!(ERR_UNKNOWN_TYPE, "未知消息类型");
        assert_eq!(err_room_exists("ABCD"), "房间 ABCD 已存在，请更换");
        assert_eq!(err_room_not_found("ABCD"), "房间 ABCD 不存在");
    }

    #[test]
    fn resume_error_texts_are_frozen() {
        assert_eq!(ERR_RESUME_REJECTED, "房间已失效，请重新加入");
        assert_eq!(ERR_RESUME_TOKEN_INVALID, "座位凭证无效");
        assert_eq!(code::RESUME_REJECTED, "RESUME_REJECTED");
        assert_eq!(code::RESUME_TOKEN_INVALID, "RESUME_TOKEN_INVALID");
    }

    #[test]
    fn constructors_produce_expected_json() {
        assert_eq!(
            created("ABCD", "p1").encode(),
            r#"{"t":"created","room":"ABCD","peerId":"p1"}"#
        );
        assert_eq!(
            created_with_token("ABCD", "p1", "tok").encode(),
            r#"{"t":"created","room":"ABCD","peerId":"p1","token":"tok"}"#
        );
        assert_eq!(
            joined("ABCD", "p1").encode(),
            r#"{"t":"joined","room":"ABCD","peerId":"p1"}"#
        );
        assert_eq!(
            joined_with_token("ABCD", "p1", "tok").encode(),
            r#"{"t":"joined","room":"ABCD","peerId":"p1","token":"tok"}"#
        );
        assert_eq!(
            peer_joined("p1", "n").encode(),
            r#"{"t":"peer-joined","peerId":"p1","name":"n"}"#
        );
        assert_eq!(peer_left().encode(), r#"{"t":"peer-left"}"#);
        assert_eq!(
            signal(serde_json::json!({"k":1})).encode(),
            r#"{"t":"signal","data":{"k":1}}"#
        );
        assert_eq!(
            error(ERR_UNKNOWN_TYPE).encode(),
            r#"{"t":"error","message":"未知消息类型"}"#
        );
        assert_eq!(
            error_with_code(ERR_RESUME_TOKEN_INVALID, code::RESUME_TOKEN_INVALID).encode(),
            r#"{"t":"error","message":"座位凭证无效","code":"RESUME_TOKEN_INVALID"}"#
        );
        assert_eq!(pong(Some(7.0)).encode(), r#"{"t":"pong","ts":7.0}"#);
        assert_eq!(pong(None).encode(), r#"{"t":"pong"}"#);
        assert_eq!(
            peer_offline(60).encode(),
            r#"{"t":"peer-offline","graceSec":60}"#
        );
        assert_eq!(peer_online().encode(), r#"{"t":"peer-online"}"#);
        assert_eq!(
            resumed("ABCD", "p1", "tok", true).encode(),
            r#"{"t":"resumed","room":"ABCD","peerId":"p1","token":"tok","peerPresent":true}"#
        );
    }
}
