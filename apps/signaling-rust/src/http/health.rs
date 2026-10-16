//! `GET /healthz` — liveness probe, field/type-compatible with v1.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use super::AppState;

/// Return `{ok:true, rooms, uptime}`.
pub async fn healthz(State(state): State<AppState>) -> Response {
    let uptime = state.started.elapsed().as_secs();
    Json(json!({
        "ok": true,
        "rooms": state.rooms.len(),
        "uptime": uptime,
    }))
    .into_response()
}
