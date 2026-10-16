//! HTTP counting middleware (Prometheus).

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;

use crate::metrics::Metrics;

/// Count every handled HTTP request.
pub async fn count_requests(
    State(metrics): State<Arc<Metrics>>,
    request: Request,
    next: Next,
) -> Response {
    metrics.inc_http_request();
    next.run(request).await
}
