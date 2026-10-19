//! WebSocket signaling protocol — the single Rust-side source of truth.
//!
//! Field names / types / error strings are byte-for-byte aligned with
//! `packages/shared/src/types.ts` (v1.1, the only contract source).
//!
//! The v1 message set is frozen; v1.1 only *adds* message types
//! (`pong` / `peer-offline` / `peer-online` / `resumed`) and *optional* fields
//! (`created.token`, `joined.token`, `error.code`). Additive changes keep old
//! clients working: unknown `t` values are ignored by them, unknown fields are
//! ignored by every JSON parser.

pub mod messages;

pub use messages::{
    err_room_exists, err_room_not_found, ERR_RESUME_REJECTED, ERR_RESUME_TOKEN_INVALID,
    ERR_ROOM_FORMAT, ERR_ROOM_FULL, ERR_UNKNOWN_TYPE,
};

use serde::{Deserialize, Serialize};

/// Server → client signaling messages (PRD §4.3 + reconnect §4.1).
///
/// Serialized with the discriminant `t`; variant names are kebab-cased so
/// `PeerJoined` becomes `"peer-joined"`. Field order matches the TypeScript
/// declaration order exactly — the exact-JSON tests depend on it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ServerMsg {
    /// Validated lobby snapshot (no credentials or signaling payloads).
    LobbyState {
        #[serde(flatten)]
        state: serde_json::Map<String, serde_json::Value>,
    },
    /// Real room admission, issued by the existing seat registry.
    LobbySeat {
        room: String,
        role: String,
        #[serde(rename = "peerId")]
        peer_id: String,
        token: String,
    },
    /// Recoverable lobby action feedback.
    LobbyNotice { code: String, message: String },
    /// `{t:'created', room, peerId, token}`
    Created {
        /// 4-char upper-case room code.
        room: String,
        /// 8-char base36 peer id.
        #[serde(rename = "peerId")]
        peer_id: String,
        /// Seat credential (v1.1; omitted only for legacy callers).
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
    /// `{t:'joined', room, peerId, token}`
    Joined {
        /// 4-char upper-case room code.
        room: String,
        /// 8-char base36 peer id.
        #[serde(rename = "peerId")]
        peer_id: String,
        /// Seat credential (v1.1).
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
    /// `{t:'peer-joined', peerId, name}`
    PeerJoined {
        /// Joining peer id.
        #[serde(rename = "peerId")]
        peer_id: String,
        /// Display name (already truncated to 20 chars).
        name: String,
    },
    /// `{t:'peer-left'}` — only sent after the grace period expires.
    PeerLeft,
    /// `{t:'signal', data}` — `data` is opaque and relayed verbatim.
    Signal {
        /// Opaque signaling payload.
        data: serde_json::Value,
    },
    /// `{t:'error', message, code?}`
    Error {
        /// Error text (see [`messages`]).
        message: String,
        /// Machine-readable code (v1.1; `None` keeps the v1 shape).
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// `{t:'pong', ts?}` — application-level heartbeat reply.
    Pong {
        /// Echo of the client's `ts` (omitted when the client sent none).
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<f64>,
    },
    /// `{t:'peer-offline', graceSec}` — opponent socket dropped, seat kept.
    PeerOffline {
        /// Grace window in seconds (the client's countdown source of truth).
        #[serde(rename = "graceSec")]
        grace_sec: u32,
    },
    /// `{t:'peer-online'}` — opponent came back inside the grace window.
    PeerOnline,
    /// `{t:'resumed', room, peerId, token, peerPresent?}`
    Resumed {
        /// 4-char upper-case room code.
        room: String,
        /// Restored peer id (identical to the request).
        #[serde(rename = "peerId")]
        peer_id: String,
        /// Rotated seat credential (the old one is now invalid).
        token: String,
        /// Whether an opponent still holds a seat in the room.
        #[serde(rename = "peerPresent", skip_serializing_if = "Option::is_none")]
        peer_present: Option<bool>,
    },
}

impl ServerMsg {
    /// Encode to a JSON text frame.
    ///
    /// Serialization of these variants cannot fail; the fallback keeps the hot
    /// path panic-free without an `unwrap`.
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| messages::ENCODE_FALLBACK.to_string())
    }
}

/// Classification of an inbound client frame (PRD §4.2 / §9.5).
#[derive(Clone, Debug, PartialEq)]
pub enum Classification {
    /// `create` with an optional (already coerced) room.
    Create {
        /// Coerced room string; `None` only when the key is absent.
        room: Option<String>,
    },
    /// `join` with room and name (both coerced to `""` when missing).
    Join {
        /// Coerced room string.
        room: String,
        /// Coerced name (not yet truncated).
        name: String,
    },
    /// `signal` with a non-falsy payload.
    Signal {
        /// Opaque payload.
        data: serde_json::Value,
    },
    /// `leave`
    Leave,
    /// `ping` with an optional echoed timestamp (v1.1).
    Ping {
        /// Client timestamp, echoed back verbatim when present.
        ts: Option<f64>,
    },
    /// `resume` — reclaim a seat inside the grace window (v1.1).
    Resume {
        /// Coerced room string (not yet validated).
        room: String,
        /// Coerced peer id of the seat to reclaim.
        peer_id: String,
        /// Coerced seat credential.
        token: String,
    },
    /// `t` is a string but not one of the known types → `error`.
    UnknownType,
    /// Malformed / non-object / missing string `t` / falsy `data` → silent.
    Ignore,
}

/// Classify a raw inbound frame.
///
/// Silent-ignore rules (exactly replicated from v1):
/// * unparseable JSON → [`Classification::Ignore`]
/// * non-object value → [`Classification::Ignore`]
/// * missing / non-string `t` → [`Classification::Ignore`]
/// * `signal` whose `data` is falsy → [`Classification::Ignore`]
///
/// An unknown *string* `t` is [`Classification::UnknownType`].
pub fn classify(raw: &str) -> Classification {
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Classification::Ignore,
    };
    let t = match value.get("t").and_then(serde_json::Value::as_str) {
        Some(t) => t,
        None => return Classification::Ignore,
    };
    match t {
        "create" => Classification::Create {
            room: coerce_opt_str(value.get("room")),
        },
        "join" => Classification::Join {
            room: coerce_str(value.get("room")),
            name: coerce_str(value.get("name")),
        },
        "signal" => match value.get("data") {
            Some(d) if !is_falsy(d) => Classification::Signal { data: d.clone() },
            _ => Classification::Ignore,
        },
        "leave" => Classification::Leave,
        // v1.1: `ping` must never touch connection/room state — only `pong`.
        "ping" => Classification::Ping {
            ts: value.get("ts").and_then(serde_json::Value::as_f64),
        },
        "resume" => Classification::Resume {
            room: coerce_str(value.get("room")),
            peer_id: coerce_str(value.get("peerId")),
            token: coerce_str(value.get("token")),
        },
        _ => Classification::UnknownType,
    }
}

/// Replicate JS `String(x || '')`: strings verbatim, non-zero numbers in
/// decimal, everything falsy (or of another type) becomes `""`.
pub fn coerce_str(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => {
            if n.as_f64().map(|f| f == 0.0).unwrap_or(false) {
                String::new()
            } else {
                n.to_string()
            }
        }
        _ => String::new(),
    }
}

/// Coerce an optional field. `None` only when the key is absent; a present but
/// null/non-coercible value becomes `Some("")` so the caller can reject it.
pub fn coerce_opt_str(value: Option<&serde_json::Value>) -> Option<String> {
    value.map(|v| coerce_str(Some(v)))
}

/// JS falsy semantics for the `signal.data` guard: `null | false | 0 | ""`.
///
/// Empty objects / arrays are *truthy* in JS and therefore forwarded.
pub fn is_falsy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::Bool(b) => !*b,
        serde_json::Value::Number(n) => n.as_f64().map(|f| f == 0.0).unwrap_or(false),
        serde_json::Value::String(s) => s.is_empty(),
        _ => false,
    }
}

/// Truncate a display name to 20 Unicode scalar values (never splitting a
/// multi-byte character).
pub fn truncate_name(name: &str) -> String {
    name.chars().take(messages::NAME_MAX_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc(m: &ServerMsg) -> String {
        m.encode()
    }

    #[test]
    fn created_serialization_is_exact() {
        let m = ServerMsg::Created {
            room: "ABCD".into(),
            peer_id: "abcd1234".into(),
            token: Some("tok".into()),
        };
        assert_eq!(
            enc(&m),
            r#"{"t":"created","room":"ABCD","peerId":"abcd1234","token":"tok"}"#
        );
    }

    /// Legacy shape: a `None` token must not add a `token` key at all, so the
    /// v1 byte layout stays intact.
    #[test]
    fn created_without_token_keeps_v1_shape() {
        let m = ServerMsg::Created {
            room: "ABCD".into(),
            peer_id: "abcd1234".into(),
            token: None,
        };
        assert_eq!(
            enc(&m),
            r#"{"t":"created","room":"ABCD","peerId":"abcd1234"}"#
        );
    }

    #[test]
    fn joined_serialization_is_exact() {
        let m = ServerMsg::Joined {
            room: "WXYZ".into(),
            peer_id: "zz99yy88".into(),
            token: Some("tok".into()),
        };
        assert_eq!(
            enc(&m),
            r#"{"t":"joined","room":"WXYZ","peerId":"zz99yy88","token":"tok"}"#
        );
    }

    #[test]
    fn peer_joined_serialization_is_exact() {
        let m = ServerMsg::PeerJoined {
            peer_id: "abcd1234".into(),
            name: "小明".into(),
        };
        assert_eq!(
            enc(&m),
            r#"{"t":"peer-joined","peerId":"abcd1234","name":"小明"}"#
        );
    }

    #[test]
    fn peer_left_serialization_is_exact() {
        assert_eq!(enc(&ServerMsg::PeerLeft), r#"{"t":"peer-left"}"#);
    }

    #[test]
    fn signal_serialization_is_exact() {
        let m = ServerMsg::Signal {
            data: serde_json::json!({"kind":"offer","sdp":"x"}),
        };
        assert_eq!(
            enc(&m),
            r#"{"t":"signal","data":{"kind":"offer","sdp":"x"}}"#
        );
    }

    #[test]
    fn error_serialization_is_exact() {
        let m = ServerMsg::Error {
            message: ERR_UNKNOWN_TYPE.into(),
            code: None,
        };
        assert_eq!(enc(&m), r#"{"t":"error","message":"未知消息类型"}"#);

        let coded = ServerMsg::Error {
            message: ERR_RESUME_TOKEN_INVALID.into(),
            code: Some(messages::code::RESUME_TOKEN_INVALID.into()),
        };
        assert_eq!(
            enc(&coded),
            r#"{"t":"error","message":"座位凭证无效","code":"RESUME_TOKEN_INVALID"}"#
        );
    }

    #[test]
    fn pong_serialization_is_exact() {
        assert_eq!(
            enc(&ServerMsg::Pong { ts: Some(1.5) }),
            r#"{"t":"pong","ts":1.5}"#
        );
        assert_eq!(enc(&ServerMsg::Pong { ts: None }), r#"{"t":"pong"}"#);
    }

    #[test]
    fn peer_offline_and_online_serialization_is_exact() {
        assert_eq!(
            enc(&ServerMsg::PeerOffline { grace_sec: 60 }),
            r#"{"t":"peer-offline","graceSec":60}"#
        );
        assert_eq!(enc(&ServerMsg::PeerOnline), r#"{"t":"peer-online"}"#);
    }

    #[test]
    fn resumed_serialization_is_exact() {
        let m = ServerMsg::Resumed {
            room: "ABCD".into(),
            peer_id: "abcd1234".into(),
            token: "tok".into(),
            peer_present: Some(true),
        };
        assert_eq!(
            enc(&m),
            r#"{"t":"resumed","room":"ABCD","peerId":"abcd1234","token":"tok","peerPresent":true}"#
        );
        // `peerPresent` is optional: absent when unknown (old-server shape).
        let bare = ServerMsg::Resumed {
            room: "ABCD".into(),
            peer_id: "abcd1234".into(),
            token: "tok".into(),
            peer_present: None,
        };
        assert_eq!(
            enc(&bare),
            r#"{"t":"resumed","room":"ABCD","peerId":"abcd1234","token":"tok"}"#
        );
    }

    #[test]
    fn classify_ping() {
        assert_eq!(
            classify(r#"{"t":"ping","ts":123.5}"#),
            Classification::Ping { ts: Some(123.5) }
        );
        assert_eq!(
            classify(r#"{"t":"ping"}"#),
            Classification::Ping { ts: None }
        );
        // A non-numeric ts is simply dropped, never an error.
        assert_eq!(
            classify(r#"{"t":"ping","ts":"x"}"#),
            Classification::Ping { ts: None }
        );
    }

    #[test]
    fn classify_resume_coerces_missing_fields_to_empty() {
        assert_eq!(
            classify(r#"{"t":"resume","room":"abcd","peerId":"abcd1234","token":"tok"}"#),
            Classification::Resume {
                room: "abcd".into(),
                peer_id: "abcd1234".into(),
                token: "tok".into(),
            }
        );
        assert_eq!(
            classify(r#"{"t":"resume"}"#),
            Classification::Resume {
                room: String::new(),
                peer_id: String::new(),
                token: String::new(),
            }
        );
    }

    #[test]
    fn classify_bad_json_is_ignore() {
        assert_eq!(classify("{not json"), Classification::Ignore);
    }

    #[test]
    fn classify_non_object_is_ignore() {
        assert_eq!(classify("[1,2,3]"), Classification::Ignore);
        assert_eq!(classify("\"hello\""), Classification::Ignore);
        assert_eq!(classify("42"), Classification::Ignore);
        assert_eq!(classify("null"), Classification::Ignore);
    }

    #[test]
    fn classify_missing_or_nonstring_t_is_ignore() {
        assert_eq!(classify("{}"), Classification::Ignore);
        assert_eq!(classify(r#"{"room":"ABCD"}"#), Classification::Ignore);
        assert_eq!(classify(r#"{"t":123}"#), Classification::Ignore);
        assert_eq!(classify(r#"{"t":null}"#), Classification::Ignore);
    }

    #[test]
    fn classify_create() {
        assert_eq!(
            classify(r#"{"t":"create"}"#),
            Classification::Create { room: None }
        );
        assert_eq!(
            classify(r#"{"t":"create","room":"abcd"}"#),
            Classification::Create {
                room: Some("abcd".into())
            }
        );
        assert_eq!(
            classify(r#"{"t":"create","room":null}"#),
            Classification::Create {
                room: Some(String::new())
            }
        );
    }

    #[test]
    fn classify_join_defaults_to_empty_strings() {
        assert_eq!(
            classify(r#"{"t":"join","room":"abcd"}"#),
            Classification::Join {
                room: "abcd".into(),
                name: String::new()
            }
        );
        assert_eq!(
            classify(r#"{"t":"join","room":"abcd","name":"小明"}"#),
            Classification::Join {
                room: "abcd".into(),
                name: "小明".into()
            }
        );
    }

    #[test]
    fn classify_leave() {
        assert_eq!(classify(r#"{"t":"leave"}"#), Classification::Leave);
    }

    #[test]
    fn classify_unknown_type() {
        assert_eq!(classify(r#"{"t":"bogus"}"#), Classification::UnknownType);
    }

    #[test]
    fn classify_signal_falsy_is_ignore() {
        assert_eq!(classify(r#"{"t":"signal"}"#), Classification::Ignore);
        assert_eq!(
            classify(r#"{"t":"signal","data":null}"#),
            Classification::Ignore
        );
        assert_eq!(
            classify(r#"{"t":"signal","data":false}"#),
            Classification::Ignore
        );
        assert_eq!(
            classify(r#"{"t":"signal","data":0}"#),
            Classification::Ignore
        );
        assert_eq!(
            classify(r#"{"t":"signal","data":""}"#),
            Classification::Ignore
        );
    }

    #[test]
    fn classify_signal_truthy_objects_and_arrays_pass() {
        assert!(matches!(
            classify(r#"{"t":"signal","data":{"a":1}}"#),
            Classification::Signal { .. }
        ));
        // empty object / array are truthy in JS → forwarded
        assert!(matches!(
            classify(r#"{"t":"signal","data":{}}"#),
            Classification::Signal { .. }
        ));
        assert!(matches!(
            classify(r#"{"t":"signal","data":[]}"#),
            Classification::Signal { .. }
        ));
        assert!(matches!(
            classify(r#"{"t":"signal","data":"x"}"#),
            Classification::Signal { .. }
        ));
    }

    #[test]
    fn coerce_str_matches_js_semantics() {
        assert_eq!(coerce_str(Some(&serde_json::json!("abc"))), "abc");
        assert_eq!(coerce_str(Some(&serde_json::json!(123))), "123");
        assert_eq!(coerce_str(Some(&serde_json::json!(0))), "");
        assert_eq!(coerce_str(Some(&serde_json::json!(null))), "");
        assert_eq!(coerce_str(Some(&serde_json::json!(false))), "");
        assert_eq!(coerce_str(None), "");
    }

    #[test]
    fn truncate_name_is_char_safe() {
        let long = "一二三四五六七八九十一二三四五六七八九十一二三四五";
        let t = truncate_name(long);
        assert_eq!(t.chars().count(), 20);
        // multibyte safe: still valid utf-8 with 20 chars
        assert_eq!(t, "一二三四五六七八九十一二三四五六七八九十");
    }
}
