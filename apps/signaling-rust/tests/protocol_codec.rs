//! Cross-module integration test for the frozen WS protocol (T04).
//!
//! Field names / types / error strings must be byte-for-byte identical to
//! `packages/shared/src/types.ts` and to v1 (`apps/server/src/server.ts`). The unit tests inside
//! `src/protocol/*` cover each helper; this file pins the *wire* contract and
//! the silent-vs-error classification semantics end to end.

use gomoku_signaling::protocol::messages::{
    self, ERR_ROOM_FORMAT, ERR_ROOM_FULL, ERR_UNKNOWN_TYPE, NAME_MAX_CHARS,
};
use gomoku_signaling::protocol::{classify, is_falsy, truncate_name, Classification, ServerMsg};

fn enc(msg: &ServerMsg) -> String {
    msg.encode()
}

/// Decode a server message back from its wire form (proves the codec is total).
fn decode(s: &str) -> ServerMsg {
    serde_json::from_str(s).expect("decode server msg")
}

#[test]
fn every_server_message_matches_the_frozen_wire_format() {
    assert_eq!(
        enc(&messages::created("ABCD", "abcd1234")),
        r#"{"t":"created","room":"ABCD","peerId":"abcd1234"}"#
    );
    assert_eq!(
        enc(&messages::joined("ABCD", "abcd1234")),
        r#"{"t":"joined","room":"ABCD","peerId":"abcd1234"}"#
    );
    assert_eq!(
        enc(&messages::peer_joined("abcd1234", "小明")),
        r#"{"t":"peer-joined","peerId":"abcd1234","name":"小明"}"#
    );
    assert_eq!(enc(&messages::peer_left()), r#"{"t":"peer-left"}"#);
    assert_eq!(
        enc(&messages::signal(
            serde_json::json!({"kind":"offer","sdp":"v=0"})
        )),
        r#"{"t":"signal","data":{"kind":"offer","sdp":"v=0"}}"#
    );
    assert_eq!(
        enc(&messages::error(ERR_UNKNOWN_TYPE)),
        r#"{"t":"error","message":"未知消息类型"}"#
    );
}

#[test]
fn server_messages_round_trip_through_serde() {
    let cases = vec![
        messages::created("WXYZ", "zz99yy88"),
        messages::joined("WXYZ", "zz99yy88"),
        messages::peer_joined("zz99yy88", "玩家一"),
        messages::peer_left(),
        messages::signal(serde_json::json!({"ice": [1, 2, 3], "sdp": "x"})),
        messages::error(ERR_ROOM_FULL),
    ];
    for msg in cases {
        let wire = enc(&msg);
        assert_eq!(decode(&wire), msg, "round trip failed for {wire}");
    }
}

#[test]
fn the_five_error_texts_are_verbatim() {
    // PRD §4.5 — these five strings are frozen.
    assert_eq!(ERR_ROOM_FORMAT, "房间号需为 4 位字母或数字");
    assert_eq!(ERR_ROOM_FULL, "房间已满（仅支持 1v1）");
    assert_eq!(ERR_UNKNOWN_TYPE, "未知消息类型");
    assert_eq!(
        messages::err_room_exists("ABCD"),
        "房间 ABCD 已存在，请更换"
    );
    assert_eq!(messages::err_room_not_found("ABCD"), "房间 ABCD 不存在");

    // And they survive encoding.
    assert_eq!(
        enc(&messages::error(ERR_ROOM_FORMAT)),
        r#"{"t":"error","message":"房间号需为 4 位字母或数字"}"#
    );
    assert_eq!(
        enc(&messages::error(messages::err_room_exists("ABCD"))),
        r#"{"t":"error","message":"房间 ABCD 已存在，请更换"}"#
    );
}

#[test]
fn malformed_frames_are_silently_ignored() {
    // Bad JSON.
    assert_eq!(classify("{not json"), Classification::Ignore);
    // Non-object JSON.
    for raw in ["[1,2,3]", "\"hello\"", "42", "null", "true"] {
        assert_eq!(classify(raw), Classification::Ignore, "raw = {raw}");
    }
    // Missing / non-string `t`.
    for raw in ["{}", r#"{"room":"ABCD"}"#, r#"{"t":123}"#, r#"{"t":null}"#] {
        assert_eq!(classify(raw), Classification::Ignore, "raw = {raw}");
    }
    // `signal` with a falsy `data` (null / false / 0 / "").
    for raw in [
        r#"{"t":"signal"}"#,
        r#"{"t":"signal","data":null}"#,
        r#"{"t":"signal","data":false}"#,
        r#"{"t":"signal","data":0}"#,
        r#"{"t":"signal","data":""}"#,
    ] {
        assert_eq!(classify(raw), Classification::Ignore, "raw = {raw}");
    }
}

#[test]
fn unknown_string_type_is_an_error() {
    assert_eq!(classify(r#"{"t":"bogus"}"#), Classification::UnknownType);
    assert_eq!(classify(r#"{"t":""}"#), Classification::UnknownType);
}

#[test]
fn the_four_known_types_classify_correctly() {
    assert_eq!(
        classify(r#"{"t":"create","room":"abcd"}"#),
        Classification::Create {
            room: Some("abcd".into())
        }
    );
    assert_eq!(
        classify(r#"{"t":"create"}"#),
        Classification::Create { room: None }
    );
    assert_eq!(
        classify(r#"{"t":"join","room":"abcd","name":"小明"}"#),
        Classification::Join {
            room: "abcd".into(),
            name: "小明".into()
        }
    );
    assert_eq!(classify(r#"{"t":"leave"}"#), Classification::Leave);
    assert!(matches!(
        classify(r#"{"t":"signal","data":{"a":1}}"#),
        Classification::Signal { .. }
    ));
}

#[test]
fn signal_truthy_empty_containers_are_forwarded() {
    // Empty object / array are truthy in JS → forwarded (not silently dropped).
    assert!(matches!(
        classify(r#"{"t":"signal","data":{}}"#),
        Classification::Signal { .. }
    ));
    assert!(matches!(
        classify(r#"{"t":"signal","data":[]}"#),
        Classification::Signal { .. }
    ));
}

#[test]
fn falsy_semantics_match_javascript() {
    assert!(is_falsy(&serde_json::Value::Null));
    assert!(is_falsy(&serde_json::json!(false)));
    assert!(is_falsy(&serde_json::json!(0)));
    assert!(is_falsy(&serde_json::json!("")));
    assert!(!is_falsy(&serde_json::json!({})));
    assert!(!is_falsy(&serde_json::json!([])));
    assert!(!is_falsy(&serde_json::json!("x")));
    assert!(!is_falsy(&serde_json::json!(1)));
}

#[test]
fn name_truncation_is_char_safe() {
    assert_eq!(NAME_MAX_CHARS, 20);
    let long = "一二三四五六七八九十一二三四五六七八九十一二三四五";
    let truncated = truncate_name(long);
    assert_eq!(truncated.chars().count(), 20);
    assert_eq!(truncated, "一二三四五六七八九十一二三四五六七八九十");

    // ASCII shorter than the limit is untouched.
    assert_eq!(truncate_name("abc"), "abc");

    // The truncated name is still valid UTF-8 and re-encodes cleanly.
    assert_eq!(
        enc(&messages::peer_joined("p", &truncated)),
        format!(r#"{{"t":"peer-joined","peerId":"p","name":"{truncated}"}}"#)
    );
}

#[test]
fn signal_payload_is_opaque_and_preserved_verbatim() {
    // Nested / exotic JSON must survive the relay untouched.
    let data = serde_json::json!({
        "kind": "candidate",
        "candidate": "candidate:1 1 UDP 2122252543 192.168.1.2 50000 typ host",
        "nested": {"a": [1, 2, {"b": "中"}]},
    });
    let wire = enc(&messages::signal(data.clone()));
    let ServerMsg::Signal { data: decoded } = decode(&wire) else {
        panic!("expected a signal frame");
    };
    assert_eq!(decoded, data);
}
