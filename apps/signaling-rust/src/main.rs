//! Binary entry point: load configuration, initialise tracing, wire the state
//! graph, serve HTTP/WS, and handle signals (SIGTERM/SIGINT → graceful
//! shutdown, SIGHUP → hot reload).

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::signal::unix::{signal, SignalKind};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, reload, EnvFilter};

use gomoku_signaling::config::{env, Config, ConfigSnapshot, EnvSource, ProcessEnv};
use gomoku_signaling::http::router::build_router;
use gomoku_signaling::http::{static_files, AppState, LogLevelSetter};
use gomoku_signaling::metrics::Metrics;
use gomoku_signaling::relay;
use gomoku_signaling::rooms::{LocalDelivery, RoomTable};
use gomoku_signaling::transport::registry::ConnectionRegistry;
use gomoku_signaling::transport::shutdown::Shutdown;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let snapshot = Config::load()?;
    let cfg = snapshot.snapshot();

    let log_setter = init_tracing(&cfg.logging.level, &cfg.logging.format);

    let metrics = Arc::new(Metrics::new());
    let rooms = Arc::new(RoomTable::new(u64::from(cfg.limits.max_rooms)));
    let conns = Arc::new(ConnectionRegistry::new(
        cfg.limits.max_connections,
        cfg.limits.max_connections_per_ip,
    ));
    let shutdown = Shutdown::new();

    let delivery: Arc<dyn LocalDelivery> = rooms.clone();
    let (relay, _subscriber) =
        relay::build(&cfg, delivery, metrics.clone(), shutdown.subscribe()).await;

    // F4: 后台周期刷新房间 TTL（周期 = room_ttl/3），热路径零额外 Redis RTT。
    // 仅当 Redis 处于启用状态时才需要（单节点 / 禁用时无键可刷新）。
    let _ttl_refresher = if cfg.redis.is_active() {
        Some(relay::spawn_ttl_refresher(
            rooms.clone(),
            relay.clone(),
            snapshot.clone(),
            shutdown.subscribe(),
        ))
    } else {
        None
    };

    let public_dir = static_files::resolve_public_dir(&cfg.server.public_dir);

    let state = AppState {
        cfg: snapshot.clone(),
        rooms: rooms.clone(),
        conns: conns.clone(),
        relay,
        metrics: metrics.clone(),
        shutdown: shutdown.clone(),
        node_id: Arc::from(cfg.cluster.node_id.as_str()),
        started: Instant::now(),
        public_dir,
        log_level: Some(log_setter),
    };

    tracing::info!(
        node_id = %cfg.cluster.node_id,
        config = ?cfg.redacted(),
        "生效配置"
    );

    let app = build_router(state.clone());
    let addr = format!("{}:{}", cfg.server.host, cfg.server.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(addr = %addr, "信令服务器已启动");

    let shutdown_wait = {
        let mut rx = shutdown.subscribe();
        async move {
            let _ = rx.wait_for(|value| *value).await;
        }
    };

    let handshake_timeout = Duration::from_secs(cfg.timeouts.ws_handshake_timeout_secs);
    let mut serve_handle = tokio::spawn(gomoku_signaling::http::serve(
        listener,
        app,
        handshake_timeout,
        shutdown_wait,
    ));

    spawn_signal_handler(state.clone(), snapshot.clone());

    let mut rx = shutdown.subscribe();
    let _ = rx.wait_for(|value| *value).await;

    let drain = Duration::from_secs(cfg.timeouts.shutdown_drain_secs);
    let drained = shutdown.drain(drain).await;
    if !drained {
        tracing::warn!("排空超时，强制关闭剩余连接");
        serve_handle.abort();
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), &mut serve_handle).await;
    tracing::info!("进程退出");
    Ok(())
}

/// Initialise structured logging and return a hot-reloadable level setter.
fn init_tracing(level: &str, format: &str) -> LogLevelSetter {
    let filter = EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new("info"));
    let (filter_layer, handle) = reload::Layer::new(filter);

    if format == "json" {
        tracing_subscriber::registry()
            .with(filter_layer)
            .with(fmt::layer().json())
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter_layer)
            .with(fmt::layer())
            .init();
    }

    Arc::new(move |level: &str| {
        EnvFilter::try_new(level)
            .map_err(|err| err.to_string())
            .and_then(|filter| handle.reload(filter).map_err(|err| err.to_string()))
    })
}

fn spawn_signal_handler(state: AppState, snapshot: Arc<ConfigSnapshot>) {
    tokio::spawn(async move {
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(sig) => sig,
            Err(_) => return,
        };
        let mut sigint = match signal(SignalKind::interrupt()) {
            Ok(sig) => sig,
            Err(_) => return,
        };
        let mut sighup = match signal(SignalKind::hangup()) {
            Ok(sig) => sig,
            Err(_) => return,
        };
        loop {
            tokio::select! {
                _ = sigterm.recv() => {
                    tracing::info!("收到 SIGTERM，开始优雅关闭");
                    state.shutdown.trigger();
                    break;
                }
                _ = sigint.recv() => {
                    tracing::info!("收到 SIGINT，开始优雅关闭");
                    state.shutdown.trigger();
                    break;
                }
                _ = sighup.recv() => handle_reload(&state, &snapshot),
            }
        }
    });
}

/// SIGHUP handler: re-read file + env, validate, diff, store.
fn handle_reload(state: &AppState, snapshot: &ConfigSnapshot) {
    let path = ProcessEnv
        .get(env::KEY_CONFIG_FILE)
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "config.toml".to_string());
    match gomoku_signaling::config::reload(snapshot, Path::new(&path), &ProcessEnv) {
        Ok(report) => {
            let cfg = state.cfg.snapshot();
            state.apply_runtime(&cfg);
            tracing::info!(
                applied = ?report.applied,
                restart_required = ?report.restart_required,
                "热重载完成"
            );
        }
        Err(err) => tracing::error!(error = %err, "热重载失败，保留旧配置"),
    }
}
