//! 全局共享应用程序状态 (AppState)
//!
//! `AppState` 被 `http` 层（路由分发器/处理器）与 `admin` 层（管理控制台处理器）共同引用。
//! 抽离到本模块使模块间的依赖单向流动：
//!
//! ```text
//! state ◄── admin ◄── http ◄── main
//! ```
//!
//! `admin` 模块绝不反向引用 `http`（严格遵循架构分层规范）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use crate::config::{Config, ConfigSnapshot};
use crate::metrics::Metrics;
use crate::relay::Relay;
use crate::rooms::RoomTable;
use crate::transport::registry::ConnectionRegistry;
use crate::transport::seat::SeatRegistry;
use crate::transport::shutdown::Shutdown;
use crate::transport::ConnDeps;

/// 运行时动态变更 tracing 日志过滤级别的闭包回调类型
pub type LogLevelSetter = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// 全局共享状态结构体（跨线程廉价克隆 Clone，内部各字段均为 Arc 引用计数指针）
#[derive(Clone)]
pub struct AppState {
    /// Node-local service lobby. Room admission still uses RoomTable and Relay.
    pub lobby: Arc<tokio::sync::Mutex<crate::transport::lobby::Lobby>>,
    /// 原子化配置快照（基于 ArcSwap，支持多线程高并发只读与原子热替换）
    pub cfg: Arc<ConfigSnapshot>,
    /// 64 分片并发房间注册表
    pub rooms: Arc<RoomTable>,
    /// 全局与单 IP 连接限流器
    pub conns: Arc<ConnectionRegistry>,
    /// 跨节点集群消息中继器（支持单机内存通道与 Redis 分布式通道）
    pub relay: Arc<dyn Relay>,
    /// Prometheus 度量监控中心
    pub metrics: Arc<Metrics>,
    /// 优雅停机信号广播协调器
    pub shutdown: Shutdown,
    /// 座位簿记与断线重连管理器
    pub seats: Arc<SeatRegistry>,
    /// 本节点在分布式集群中的唯一标识 ID（如 "node-beijing-1"）
    pub node_id: Arc<str>,
    /// 进程启动时间戳，用于高精度计算 uptime 运行时间
    pub started: Instant,
    /// 启动时已探查就绪的前端静态文件绝对根路径
    pub public_dir: PathBuf,
    /// 动态修改日志过滤级别的句柄
    pub log_level: Option<LogLevelSetter>,
}

impl AppState {
    /// 从全局状态中抽取并组装连接级别的依赖项包 (ConnDeps)
    /// 避免在每个长连接任务中暴露不必要的关机/静态目录等管理能力（遵循接口隔离原则 ISP）
    pub fn conn_deps(&self) -> ConnDeps {
        ConnDeps {
            lobby: self.lobby.clone(),
            cfg: self.cfg.clone(),
            rooms: self.rooms.clone(),
            conns: self.conns.clone(),
            relay: self.relay.clone(),
            metrics: self.metrics.clone(),
            seats: self.seats.clone(),
            node_id: self.node_id.clone(),
        }
    }

    /// 应用动态热重载配置的运行时副作用：
    /// - 连接级别的参数（如缓冲区大小、超时）自然作用于后续建立的新连接；
    /// - 全局级别的参数（连接数上限、IP 限流上限、房间总数上限、日志级别）即刻生效！
    pub fn apply_runtime(&self, cfg: &Config) {
        self.conns.set_limits(
            cfg.limits.max_connections,
            cfg.limits.max_connections_per_ip,
        );
        self.rooms.set_max_rooms(u64::from(cfg.limits.max_rooms));
        self.seats
            .set_grace_ms(cfg.session.grace_secs.saturating_mul(1000));
        if let Some(setter) = &self.log_level {
            let _ = setter(&cfg.logging.level);
        }
    }
}
