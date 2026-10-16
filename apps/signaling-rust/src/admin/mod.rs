//! Management API: Bearer token auth (constant-time) and config endpoints.

pub mod auth;
pub mod handlers;

use axum::routing::get;
use axum::Router;

use crate::state::AppState;

/// Routes for the management surface (token-gated inside the handlers so an
/// unset token yields 404 — PRD §4.4).
pub fn admin_router() -> Router<AppState> {
    Router::new().route(
        "/admin/config",
        get(handlers::get_config).post(handlers::post_config),
    )
}
