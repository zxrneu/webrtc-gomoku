//! Regression test for P1-1: Redis must never block startup.
//!
//! `relay::build` must return immediately even when Redis is unreachable; the
//! connection is established on a background task with a `1s → 30s` backoff.
//! This test needs **no real Redis** — it points at a closed port.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gomoku_signaling::config::Config;
use gomoku_signaling::metrics::Metrics;
use gomoku_signaling::relay::{self, CrossKind, CrossNodeMsg, Relay, RelayError};
use gomoku_signaling::rooms::{LocalDelivery, PeerId, RoomCode, RoomTable};
use tokio::sync::watch;

#[tokio::test]
async fn unreachable_redis_does_not_block_build() {
    let mut cfg = Config::default();
    // Nothing is listening here (the tests must not require Redis).
    cfg.redis.url = "redis://127.0.0.1:6399".into();
    cfg.redis.connect_timeout_ms = 200;

    let delivery: Arc<dyn LocalDelivery> = Arc::new(RoomTable::default());
    let metrics = Arc::new(Metrics::new());
    let (_tx, rx) = watch::channel(false);

    let start = Instant::now();
    let (relay, handle) = tokio::time::timeout(
        Duration::from_secs(5),
        relay::build(&cfg, delivery, metrics, rx),
    )
    .await
    .expect("build() must not block on an unreachable Redis");
    let elapsed = start.elapsed();

    // The old implementation awaited an in-library backoff and took ~238s.
    assert!(
        elapsed < Duration::from_secs(1),
        "build() took {elapsed:?}; it must return immediately and connect in the background"
    );

    // Degraded mode: not connected, and every cross-node call falls back.
    assert!(!relay.is_connected());
    let msg = CrossNodeMsg::new(
        CrossKind::Signal,
        &RoomCode::new("ABCD").expect("code"),
        "n",
        &PeerId::new("aaaaaaaa").expect("peer"),
    );
    assert!(matches!(
        relay.publish(msg).await,
        Err(RelayError::Unavailable(_))
    ));

    if let Some(handle) = handle {
        handle.abort();
    }
}

/// When the relay is switched off, `build` must not spawn a background task at
/// all — that is what makes a single-node deployment quiet (no reconnect churn,
/// no `warn` log every 30s).
#[tokio::test]
async fn disabled_relay_spawns_no_background_task() {
    let mut cfg = Config::default();
    cfg.redis.enabled = false;

    let delivery: Arc<dyn LocalDelivery> = Arc::new(RoomTable::default());
    let metrics = Arc::new(Metrics::new());
    let (_tx, rx) = watch::channel(false);

    let (relay, handle) = relay::build(&cfg, delivery, metrics, rx).await;

    assert!(handle.is_none(), "禁用时不得 spawn 后台重连任务");
    assert!(!relay.is_connected());

    // Local-only behaviour is unchanged: cross-node calls fall back.
    let msg = CrossNodeMsg::new(
        CrossKind::Signal,
        &RoomCode::new("ABCD").expect("code"),
        "n",
        &PeerId::new("aaaaaaaa").expect("peer"),
    );
    assert!(matches!(
        relay.publish(msg).await,
        Err(RelayError::Unavailable(_))
    ));
}

/// An empty `redis.url` is an equivalent way to opt out.
#[tokio::test]
async fn empty_redis_url_also_disables_relay() {
    let mut cfg = Config::default();
    cfg.redis.url = String::new();
    assert!(!cfg.redis.is_active());

    let delivery: Arc<dyn LocalDelivery> = Arc::new(RoomTable::default());
    let metrics = Arc::new(Metrics::new());
    let (_tx, rx) = watch::channel(false);

    let (_relay, handle) = relay::build(&cfg, delivery, metrics, rx).await;
    assert!(
        handle.is_none(),
        "空 redis.url 应等同禁用，不 spawn 后台任务"
    );
}
