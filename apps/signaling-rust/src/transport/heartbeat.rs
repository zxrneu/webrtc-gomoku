//! Heartbeat helpers.
//!
//! The liveness decision is a pure function of an injected clock so it can be
//! unit-tested without real time (AGENTS.md DIP).

use std::time::{SystemTime, UNIX_EPOCH};

/// Current wall-clock time in epoch milliseconds.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `true` when the connection has been silent for at least `idle_timeout_secs`.
///
/// Aligned with v1: two missed ping periods ⇒ dead.
pub fn is_dead(now_ms: u64, last_seen_ms: u64, idle_timeout_secs: u64) -> bool {
    now_ms.saturating_sub(last_seen_ms) >= idle_timeout_secs.saturating_mul(1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_connection_is_alive() {
        assert!(!is_dead(1_000, 1_000, 60));
        assert!(!is_dead(59_000, 1_000, 60));
    }

    #[test]
    fn exact_idle_boundary_is_dead() {
        assert!(is_dead(61_000, 1_000, 60));
    }

    #[test]
    fn stale_connection_is_dead() {
        assert!(is_dead(1_000_000, 1_000, 60));
    }

    #[test]
    fn future_timestamps_do_not_panic() {
        // saturating_sub guards a clock that moved backwards
        assert!(!is_dead(1_000, 5_000, 60));
    }
}
