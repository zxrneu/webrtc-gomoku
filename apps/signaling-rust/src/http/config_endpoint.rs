//! `GET /config` — hands the client its `RTCIceServer[]`.

use axum::extract::State;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::config::IceConfig;

use super::AppState;

/// Build the standard `RTCIceServer[]` shape from the ICE configuration.
///
/// The TURN section appears only when `turn_url` is set *and*
/// `turn_credential_exposed` is `true` (PRD §12-Q1).
pub fn build_ice_servers(ice: &IceConfig) -> Vec<Value> {
    let mut servers: Vec<Value> = Vec::new();
    if !ice.stun_servers.is_empty() {
        servers.push(json!({ "urls": ice.stun_servers }));
    }
    if !ice.turn_url.is_empty() && ice.turn_credential_exposed {
        servers.push(json!({
            "urls": [ice.turn_url],
            "username": ice.turn_username,
            "credential": ice.turn_credential,
        }));
    }
    servers
}

/// Return `{iceServers:[...]}` with `Cache-Control: no-cache`.
pub async fn config(State(state): State<AppState>) -> Response {
    let cfg = state.cfg.snapshot();
    let servers = build_ice_servers(&cfg.ice);
    let mut response = Json(json!({ "iceServers": servers, "capabilities": {"lobby":true,"invites":true}, "lobby": {"inviteTimeoutMs":30000,"matchTimeoutMs":60000} })).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn config_advertises_lobby_and_invitation_capabilities() {
        let state = crate::http::test_support::state_with(crate::config::Config::default());
        let response = config(State(state)).await;
        let bytes = axum::body::to_bytes(response.into_body(), 65536)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["capabilities"]["lobby"], true);
        assert_eq!(value["capabilities"]["invites"], true);
        assert_eq!(value["lobby"]["inviteTimeoutMs"], 30000);
    }

    fn ice(stun: &[&str], turn: &str, exposed: bool) -> IceConfig {
        IceConfig {
            stun_servers: stun.iter().map(|s| (*s).to_string()).collect(),
            turn_url: turn.to_string(),
            turn_username: "user".to_string(),
            turn_credential: "secret".to_string(),
            turn_credential_exposed: exposed,
        }
    }

    #[test]
    fn stun_only_when_no_turn() {
        let servers = build_ice_servers(&ice(&["stun:a:3478"], "", true));
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["urls"][0], "stun:a:3478");
        assert!(servers[0].get("username").is_none());
    }

    #[test]
    fn turn_exposed_includes_credential() {
        let servers = build_ice_servers(&ice(&["stun:a:3478"], "turn:t:3478", true));
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[1]["urls"][0], "turn:t:3478");
        assert_eq!(servers[1]["username"], "user");
        assert_eq!(servers[1]["credential"], "secret");
    }

    #[test]
    fn turn_hidden_when_not_exposed() {
        let servers = build_ice_servers(&ice(&["stun:a:3478"], "turn:t:3478", false));
        assert_eq!(servers.len(), 1, "TURN section must be omitted");
    }

    #[test]
    fn no_servers_when_everything_empty() {
        let servers = build_ice_servers(&ice(&[], "", true));
        assert!(servers.is_empty());
    }
}
