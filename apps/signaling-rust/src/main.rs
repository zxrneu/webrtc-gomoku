//! 二进制程序入口 (main.rs)
//!
//! 职责：
//! 1. 加载并合并配置（默认配置 -> 配置文件 -> 环境变量覆盖）
//! 2. 初始化结构化日志系统 (tracing)，支持运行时动态修改日志级别
//! 3. 组装核心依赖图（Rooms 分片表、连接限流器、Redis/本地中继通道、指标中心）
//! 4. 绑定 TCP 端口启动 Axum HTTP / WebSocket 服务
//! 5. 监听操作系统信号：
//!    - SIGTERM / SIGINT 触发优雅关闭（优雅排空连接池）
//!    - SIGHUP 触发配置热重载（零停机更新日志级别与限流阈值）

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::signal::unix::{signal, SignalKind};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, reload, EnvFilter};

use gomoku_signaling::config::{env, Config, ConfigSnapshot, EnvSource, ProcessEnv};
use gomoku_signaling::http::router::build_router;
use gomoku_signaling::http::server::{serve_with_tls, ServerTransport};
use gomoku_signaling::http::tls::{load_tls_config, repository_root};
use gomoku_signaling::http::{static_files, AppState, LogLevelSetter};
use gomoku_signaling::metrics::Metrics;
use gomoku_signaling::relay;
use gomoku_signaling::rooms::{LocalDelivery, RoomTable};
use gomoku_signaling::transport::registry::ConnectionRegistry;
use gomoku_signaling::transport::seat::{spawn_sweeper, SeatRegistry};
use gomoku_signaling::transport::shutdown::Shutdown;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. 加载不可变配置快照
    let snapshot = Config::load()?;
    let cfg = snapshot.snapshot();
    let tls_root = repository_root(&ProcessEnv, &std::env::current_dir()?);
    let tls = load_tls_config(&ProcessEnv, &tls_root)?;
    let protocol = if tls.is_some() { "https" } else { "http" };
    let signal_protocol = if tls.is_some() { "wss" } else { "ws" };

    // 2. 初始化结构化日志输出（支持热更新 filter 级别）
    let log_setter = init_tracing(&cfg.logging.level, &cfg.logging.format);

    // 3. 构建核心业务依赖项
    let metrics = Arc::new(Metrics::new());
    // 64 分片并发房间注册表，设置房间总数硬上限
    let rooms = Arc::new(RoomTable::new(u64::from(cfg.limits.max_rooms)));
    // 全局与单 IP 连接限流器
    let conns = Arc::new(ConnectionRegistry::new(
        cfg.limits.max_connections,
        cfg.limits.max_connections_per_ip,
    ));
    // 优雅停机广播与排空协调器
    let shutdown = Shutdown::new();
    // 座位簿记与宽限期管理器
    let seats = Arc::new(SeatRegistry::new(
        cfg.session.grace_secs.saturating_mul(1000),
    ));

    // 4. 构建中继分发器（单节点使用基于 tokio 内存通道的 InProcessRelay，集群模式使用 Redis Relay）
    let delivery: Arc<dyn LocalDelivery> = rooms.clone();
    let (relay, _subscriber) =
        relay::build(&cfg, delivery, metrics.clone(), shutdown.subscribe()).await;

    // 5. 性能优化 F4：后台周期性异步刷新 Redis 房间 TTL（周期 = room_ttl / 3）
    // 核心收益：将热路径下的 Redis RTT 降为 0，高频信令转发完全不需要同步等待 Redis EXPIRE 命令！
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

    // 6. 探测解析静态文件目录（packages/web/dist -> dist -> public）
    let public_dir = static_files::resolve_public_dir(&cfg.server.public_dir);

    // 7. 组装全局共享状态 AppState
    let state = AppState {
        lobby: Arc::new(tokio::sync::Mutex::new(
            gomoku_signaling::transport::lobby::Lobby::default(),
        )),
        cfg: snapshot.clone(),
        rooms: rooms.clone(),
        conns: conns.clone(),
        relay,
        metrics: metrics.clone(),
        shutdown: shutdown.clone(),
        seats: seats.clone(),
        node_id: Arc::from(cfg.cluster.node_id.as_str()),
        started: Instant::now(),
        public_dir,
        log_level: Some(log_setter),
    };

    // 7.1 启动后台座位宽限期过期回收任务
    let _sweeper = spawn_sweeper(state.conn_deps(), shutdown.subscribe());
    let _lobby_sweeper =
        gomoku_signaling::transport::lobby::spawn_sweeper(state.conn_deps(), shutdown.subscribe());

    tracing::info!(
        node_id = %cfg.cluster.node_id,
        config = ?cfg.redacted(),
        "生效配置"
    );

    // 8. 编译 Axum HTTP / WebSocket 路由并绑定 TCP 端口
    let app = build_router(state.clone());
    let addr = format!("{}:{}", cfg.server.host, cfg.server.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(url = %format!("{protocol}://{addr}"), signal = %format!("{signal_protocol}://{addr}/signal"), "信令服务器已启动");

    // 监听停机广播的接收端
    let shutdown_wait = {
        let mut rx = shutdown.subscribe();
        async move {
            let _ = rx.wait_for(|value| *value).await;
        }
    };

    // 启动 HTTP 服务并在后台轮询连接
    let handshake_timeout = Duration::from_secs(cfg.timeouts.ws_handshake_timeout_secs);
    let mut serve_handle = tokio::spawn(serve_with_tls(
        ServerTransport {
            tcp: listener,
            tls,
            handshake_timeout,
        },
        app,
        shutdown_wait,
    ));

    // 9. 启动操作系统 Unix 信号捕获任务 (SIGTERM / SIGINT / SIGHUP)
    spawn_signal_handler(state.clone(), snapshot.clone());

    // 阻塞等待停机信号触发
    let mut rx = shutdown.subscribe();
    let _ = rx.wait_for(|value| *value).await;

    // 10. 优雅停机排空过程 (Graceful Drain)
    // 停止接收新握手，等待当前正在进行的短时任务完成，超时则强杀
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

/// 初始化结构化日志框架，返回一个可以在运行时修改过滤级别的闭包句柄 (Hot-reloadable)
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

/// 注册并监听操作系统信号（后台 tokio 任务）
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
                // Kubernetes Pod 停止或 kill 命令：触发优雅排空停机
                _ = sigterm.recv() => {
                    tracing::info!("收到 SIGTERM，开始优雅关闭");
                    state.shutdown.trigger();
                    break;
                }
                // 控制台 Ctrl+C：触发优雅停机
                _ = sigint.recv() => {
                    tracing::info!("收到 SIGINT，开始优雅关闭");
                    state.shutdown.trigger();
                    break;
                }
                // 热重载信号 kill -HUP <pid>：重新读取配置文件并原子替换，不中断当前活跃连接
                _ = sighup.recv() => handle_reload(&state, &snapshot),
            }
        }
    });
}

/// SIGHUP 信号处理函数：重新解析 config.toml 与环境变量，计算差异并原子注入
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
