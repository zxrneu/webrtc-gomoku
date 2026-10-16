//! `GET`/`POST /admin/config` handlers.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::config::{compute_reload_report, PartialConfig};
use crate::state::AppState;

use super::auth::{self, AuthOutcome};

/// `GET /admin/config` — redacted effective configuration.
pub async fn get_config(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match auth::authorize(&state.cfg.snapshot().admin.token, &headers) {
        AuthOutcome::Disabled => StatusCode::NOT_FOUND.into_response(),
        AuthOutcome::Unauthorized => StatusCode::UNAUTHORIZED.into_response(),
        AuthOutcome::Authorized => Json(state.cfg.snapshot().redacted_json()).into_response(),
    }
}

/// `POST /admin/config` — apply an in-memory configuration patch.
///
/// Returns `{applied, restart_required}`. The patch is *not* written back to
/// `config.toml` (PRD §12-Q2). Invalid patches are rejected with 400 and the
/// previous snapshot is kept.
pub async fn post_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match auth::authorize(&state.cfg.snapshot().admin.token, &headers) {
        AuthOutcome::Disabled => return StatusCode::NOT_FOUND.into_response(),
        AuthOutcome::Unauthorized => return StatusCode::UNAUTHORIZED.into_response(),
        AuthOutcome::Authorized => {}
    }

    let partial: PartialConfig = match serde_json::from_slice(&body) {
        Ok(partial) => partial,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("请求体解析失败: {err}") })),
            )
                .into_response();
        }
    };

    let mut candidate = (*state.cfg.snapshot()).clone();
    candidate.apply_partial(&partial);
    if let Err(err) = candidate.validate() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response();
    }

    let previous = state.cfg.snapshot();
    let report = compute_reload_report(&previous, &candidate);
    state.cfg.store(candidate.clone());
    state.apply_runtime(&candidate);
    Json(report).into_response()
}
