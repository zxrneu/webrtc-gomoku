//! Constant-time Bearer token authentication.

use axum::http::{header, HeaderMap};
use subtle::ConstantTimeEq;

/// Result of an authorization check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthOutcome {
    /// No token configured ⇒ the whole management surface is disabled (404).
    Disabled,
    /// A token is configured but the request did not present it correctly.
    Unauthorized,
    /// Authorized.
    Authorized,
}

/// Check the `Authorization: Bearer <token>` header against the configured token.
pub fn authorize(configured_token: &str, headers: &HeaderMap) -> AuthOutcome {
    if configured_token.is_empty() {
        return AuthOutcome::Disabled;
    }
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    match provided {
        Some(token) if constant_time_eq(configured_token.as_bytes(), token.as_bytes()) => {
            AuthOutcome::Authorized
        }
        _ => AuthOutcome::Unauthorized,
    }
}

/// Constant-time byte comparison (length difference short-circuits, which leaks
/// only the token length — an accepted, standard trade-off).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(value).expect("hv"),
        );
        headers
    }

    #[test]
    fn disabled_when_token_unset() {
        assert_eq!(
            authorize("", &headers_with("Bearer anything")),
            AuthOutcome::Disabled
        );
    }

    #[test]
    fn unauthorized_when_header_missing() {
        assert_eq!(
            authorize("secret", &HeaderMap::new()),
            AuthOutcome::Unauthorized
        );
    }

    #[test]
    fn unauthorized_when_scheme_wrong() {
        assert_eq!(
            authorize("secret", &headers_with("Basic secret")),
            AuthOutcome::Unauthorized
        );
    }

    #[test]
    fn unauthorized_when_token_wrong() {
        assert_eq!(
            authorize("secret", &headers_with("Bearer nope")),
            AuthOutcome::Unauthorized
        );
    }

    #[test]
    fn authorized_when_token_matches() {
        assert_eq!(
            authorize("secret", &headers_with("Bearer secret")),
            AuthOutcome::Authorized
        );
    }
}
