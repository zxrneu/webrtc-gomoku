//! Regression test for F4: room TTL must be refreshed by a background task.
//!
//! Rooms that live longer than `redis.room_ttl_secs` (default 1h) used to
//! expire mid-game: only `create` / `join` touched the Redis TTL, and every
//! `signal` message deliberately adds **zero** Redis RTTs (hot-path red line).
//! The refresher walks the local room table every `room_ttl / 3` seconds and
//! EXPIREs the corresponding Redis keys.
//!
//! Uses paused time so the 1200s (3600/3) first tick is instant: when the
//! test sleeps 1300s and the refresher's next tick is at 1200s, tokio's
//! auto-advance jumps straight to the refresher's deadline first.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use gomoku_signaling::config::{Config, ConfigSnapshot};
use gomoku_signaling::relay::{self, Relay};
use gomoku_signaling::rooms::{outbound_channel, ConnHandle, PeerId, RoomCode, RoomTable};

mod support;

use support::fake_relay::{FakeCluster, FakeRelay};

#[tokio::test(start_paused = true)]
async fn refresher_expires_live_rooms_every_third_of_the_ttl() {
    // Default config: room_ttl_secs = 3600 → first refresh tick at 1200s.
    let snapshot = Arc::new(ConfigSnapshot::new(Config::default()));
    assert_eq!(
        relay::ttl_refresh_interval(3_600),
        Duration::from_secs(1_200)
    );

    let rooms = Arc::new(RoomTable::default());
    let (tx, _rx) = outbound_channel(4);
    rooms
        .create(
            RoomCode::new("AB12").expect("code"),
            ConnHandle::new(
                PeerId::new("aaaaaaaa").expect("peer"),
                Arc::from("node-a"),
                tx,
                Arc::new(tokio::sync::Notify::new()),
            ),
        )
        .expect("create");

    let cluster = FakeCluster::new();
    let fake: Arc<FakeRelay> = FakeRelay::new("node-a", cluster, rooms.clone());
    let relay: Arc<dyn Relay> = fake.clone();

    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    let handle = relay::spawn_ttl_refresher(rooms, relay, snapshot, shutdown_rx);

    // 1300s > 1200s (first refresh tick): with paused time the runtime jumps
    // to the refresher's deadline before this sleep completes.
    tokio::time::sleep(Duration::from_secs(1_300)).await;
    handle.abort();

    let refreshed = fake.refreshed_codes();
    assert!(
        refreshed.contains(&"AB12".to_string()),
        "存活房间必须被周期刷新 TTL，实际刷新记录: {refreshed:?}"
    );
}

/// An empty room table must not produce any Redis traffic at all.
#[tokio::test(start_paused = true)]
async fn refresher_stays_silent_when_no_room_exists() {
    let snapshot = Arc::new(ConfigSnapshot::new(Config::default()));
    let rooms = Arc::new(RoomTable::default());
    let cluster = FakeCluster::new();
    let fake: Arc<FakeRelay> = FakeRelay::new("node-a", cluster, rooms.clone());
    let relay: Arc<dyn Relay> = fake.clone();

    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    let handle = relay::spawn_ttl_refresher(rooms, relay, snapshot, shutdown_rx);

    tokio::time::sleep(Duration::from_secs(2_400)).await;
    handle.abort();

    assert!(
        fake.refreshed_codes().is_empty(),
        "无房间时刷新器不应产生任何 Redis 调用"
    );
}
