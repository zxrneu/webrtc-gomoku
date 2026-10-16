//! Prometheus metric-name constants (`gomoku_` prefix, architecture §11).

/// Current WS connection count (gauge).
pub const WS_CONNECTIONS: &str = "gomoku_ws_connections";
/// Current room count (gauge).
pub const ROOMS: &str = "gomoku_rooms";
/// Messages by type (counter).
pub const MESSAGES_TOTAL: &str = "gomoku_messages_total";
/// Errors by kind (counter).
pub const ERRORS_TOTAL: &str = "gomoku_errors_total";
/// Signaling relay latency distribution (histogram).
pub const SIGNAL_LATENCY_SECONDS: &str = "gomoku_signal_latency_seconds";
/// Redis connectivity 0/1 (gauge).
pub const REDIS_CONNECTED: &str = "gomoku_redis_connected";
/// HTTP requests handled (counter) — used by the HTTP counting middleware.
pub const HTTP_REQUESTS_TOTAL: &str = "gomoku_http_requests_total";

/// Label name for the message-type dimension.
pub const LABEL_TYPE: &str = "type";
/// Label name for the error-kind dimension.
pub const LABEL_KIND: &str = "kind";

/// Message-type label values.
pub mod msg_type {
    /// `create`
    pub const CREATE: &str = "create";
    /// `join`
    pub const JOIN: &str = "join";
    /// `signal`
    pub const SIGNAL: &str = "signal";
    /// `leave`
    pub const LEAVE: &str = "leave";

    /// Every message type the router can record.
    ///
    /// Used to pre-register the label values at `0` so a cold, traffic-free
    /// instance still exposes `gomoku_messages_total` (PRD §6.2 / DoD10).
    pub const ALL: [&str; 4] = [CREATE, JOIN, SIGNAL, LEAVE];
}

/// Error-kind label values.
pub mod err_kind {
    /// Malformed room code.
    pub const ROOM_FORMAT: &str = "room_format";
    /// Room already exists.
    pub const ROOM_EXISTS: &str = "room_exists";
    /// Room not found.
    pub const ROOM_NOT_FOUND: &str = "room_not_found";
    /// Room full.
    pub const ROOM_FULL: &str = "room_full";
    /// Unknown message type.
    pub const UNKNOWN_TYPE: &str = "unknown_type";
    /// Slow client (outbound queue full).
    pub const SLOW_CLIENT: &str = "slow_client";
    /// Rejected because a global/per-IP limit was hit.
    pub const REJECTED: &str = "rejected";
    /// Redis / relay unavailable.
    pub const RELAY_UNAVAILABLE: &str = "relay_unavailable";
    /// Internal error (room-cap reached, code-generation retries exhausted, …).
    pub const INTERNAL: &str = "internal";
    /// An inbound frame exceeded `limits.max_message_bytes`.
    pub const MESSAGE_TOO_LARGE: &str = "message_too_large";

    /// Every error kind the server can record.
    ///
    /// Used to pre-register the label values at `0` so a cold, traffic-free
    /// instance still exposes `gomoku_errors_total` (PRD §6.2 / DoD10).
    pub const ALL: [&str; 10] = [
        ROOM_FORMAT,
        ROOM_EXISTS,
        ROOM_NOT_FOUND,
        ROOM_FULL,
        UNKNOWN_TYPE,
        SLOW_CLIENT,
        REJECTED,
        RELAY_UNAVAILABLE,
        INTERNAL,
        MESSAGE_TOO_LARGE,
    ];
}
