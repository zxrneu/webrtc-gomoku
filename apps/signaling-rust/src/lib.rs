//! WebRTC 五子棋信令服务器（Rust 高性能重写版，M3 v2.0）。
//!
//! 本服务坚持极简单一职责原则，只承担两项核心使命：
//! 1. **托管单页 Web 客户端**：提供 HTML/JS/CSS 静态资源托管与安全防范；
//! 2. **按房间中继转发 WebRTC 信令**：交换双方的 Offer/Answer SDP 与 ICE 打洞候选。
//!    **对局数据（落子、悔棋、聊天）绝对不经过服务器**，只在双方浏览器的 P2P DataChannel 中直传。
//!
//! ## 严格单向无环依赖架构图 (Strictly Acyclic Module Graph)
//!
//! ```text
//! protocol ◄── rooms ◄── transport ◄── http ◄── main
//!    ▲           ▲           ▲           ▲
//!    │           │           │           │
//! config (只读叶子节点，各层直接引用不可变配置快照)
//! metrics (只写叶子节点，各层直接打点上报 Prometheus 指标)
//!
//! relay ◄── transport
//! (跨节点分布式中继：transport 层通过 relay 发布跨机房消息；
//!  relay 层收到远端广播后，通过 `rooms::LocalDelivery` 特征 (Trait) 反向分发给本节点客户端。
//!  —— 典型的依赖反转原则 DIP：relay 绝不反向引用具体 transport 类型！)
//! ```

/// 管理端运维控制模块（支持配置热重载、服务度量统计）
pub mod admin;
/// 配置系统模块（支持内置默认值、config.toml 文件解析与环境变量覆盖，基于 ArcSwap 实现原子热更新）
pub mod config;
/// HTTP Web 协议层（基于 Axum 构建的静态文件服务器、WebSocket 握手入口与健康检查 /healthz 探针）
pub mod http;
/// Prometheus 运维监控度量指标收集模块
pub mod metrics;
/// 冻结通信协议编解码器（与前端 packages/shared/src/types.ts 逐字节对齐）
pub mod protocol;
/// 跨节点集群消息中继总线（基于 Redis Pub/Sub 与内存广播通道）
pub mod relay;
/// 节点内 64 分片无锁/细粒度锁房间注册中心 (RoomTable)
pub mod rooms;
/// 全局跨模块共享依赖状态 (AppState)
pub mod state;
/// WebSocket 连接生命周期管理、背压流量控制、心跳检测与信令路由分发 (Transport Layer)
pub mod transport;
