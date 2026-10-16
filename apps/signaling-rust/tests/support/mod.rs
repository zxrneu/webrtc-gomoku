//! Shared helpers for the cross-module integration tests (T16).
//!
//! This module is compiled into `integration_ws.rs` only; it is intentionally
//! kept free of `#[cfg(test)]` so it behaves like ordinary test scaffolding.

// Each integration-test binary includes this module wholesale, so some helpers
// are legitimately unused in a given binary. Silence dead-code per module so
// `clippy --all-targets -D warnings` stays clean across every test target.
#[allow(dead_code)]
pub mod client;
#[allow(dead_code)]
pub mod fake_relay;
