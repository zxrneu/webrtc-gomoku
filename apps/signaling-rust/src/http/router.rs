//! Router assembly: endpoints, CORS, body limit, HTTP timeout, tracing and the
//! metrics counting middleware.

use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::admin;

use super::{config_endpoint, health, static_files, ws, AppState};

/// Assemble the full application router.
pub fn build_router(state: AppState) -> Router {
    let (max_body, handshake_timeout, origins) = {
        let cfg = state.cfg.snapshot();
        (
            cfg.limits.max_message_bytes,
            Duration::from_secs(cfg.timeouts.ws_handshake_timeout_secs),
            cfg.cors.origins.clone(),
        )
    };
    let metrics_for_middleware = state.metrics.clone();

    let mut router = Router::new()
        .route("/healthz", get(health::healthz))
        .route("/config", get(config_endpoint::config))
        .route("/metrics", get(metrics_endpoint))
        .route("/signal", get(ws::ws_handler))
        .merge(admin::admin_router())
        .fallback(static_handler)
        .layer(RequestBodyLimitLayer::new(max_body))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            handshake_timeout,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(axum::middleware::from_fn_with_state(
            metrics_for_middleware,
            crate::metrics::middleware::count_requests,
        ))
        .with_state(state);

    if !origins.is_empty() {
        router = router.layer(cors_layer(&origins));
    }
    router
}

fn cors_layer(origins: &[String]) -> CorsLayer {
    let parsed: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(parsed))
        .allow_methods(Any)
        .allow_headers(Any)
}

async fn metrics_endpoint(State(state): State<AppState>) -> Response {
    state.metrics.set_rooms(state.rooms.len());
    state.metrics.set_ws_connections(state.conns.current());
    let body = state.metrics.render();
    (
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

async fn static_handler(State(state): State<AppState>, uri: Uri) -> Response {
    static_files::serve(&state.public_dir, uri.path()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::http::test_support::state_with;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    #[tokio::test]
    async fn healthz_has_v1_shape() {
        let app = build_router(state_with(Config::default()));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let value = body_json(response).await;
        assert_eq!(value["ok"], true);
        assert_eq!(value["rooms"], 0);
        assert!(value["uptime"].is_number());
    }

    #[tokio::test]
    async fn config_endpoint_turn_hidden_by_default() {
        let mut cfg = Config::default();
        cfg.ice.turn_url = "turn:t:3478".into();
        cfg.ice.turn_credential = "secret".into();
        cfg.ice.turn_credential_exposed = false;
        let app = build_router(state_with(cfg));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/config")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );
        let value = body_json(response).await;
        assert_eq!(value["iceServers"].as_array().expect("array").len(), 1);
    }

    #[tokio::test]
    async fn config_endpoint_turn_shown_when_exposed() {
        let mut cfg = Config::default();
        cfg.ice.turn_url = "turn:t:3478".into();
        cfg.ice.turn_credential = "secret".into();
        let app = build_router(state_with(cfg));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/config")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let value = body_json(response).await;
        let servers = value["iceServers"].as_array().expect("array");
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[1]["credential"], "secret");
    }

    #[tokio::test]
    async fn cors_header_absent_when_origins_empty() {
        let app = build_router(state_with(Config::default()));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .header(header::ORIGIN, "https://evil.example")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[tokio::test]
    async fn cors_header_present_when_configured() {
        let mut cfg = Config::default();
        cfg.cors.origins = vec!["https://ok.example".into()];
        let app = build_router(state_with(cfg));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .header(header::ORIGIN, "https://ok.example")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("https://ok.example")
        );
    }

    #[tokio::test]
    async fn admin_is_404_when_token_unset() {
        let app = build_router(state_with(Config::default()));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/admin/config")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn metrics_endpoint_exposes_gomoku_metrics() {
        let app = build_router(state_with(Config::default()));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("gomoku_ws_connections"));
        assert!(text.contains("gomoku_rooms"));
    }
}
