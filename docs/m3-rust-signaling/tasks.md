# M3 v2.0 · Rust 信令服务器 · 任务分解（Tasks）

| 项 | 内容 |
|---|---|
| 里程碑 | M3 · v2.0 |
| 作者 | 高见远（Gao）· 架构师 |
| 契约来源 | `docs/m3-rust-signaling/prd.md`（冻结）+ `architecture.md` |
| 落点 | `apps/signaling-rust/`（Rust crate）；前端改造在 `packages/web/` |
| 语言 | 中文 |
| 任务总数 | **18**（T01–T18） |

> **TDD 顺序**（AGENTS.md §3）：每个模块任务先写失败测试再实现。Rust 单测内联 `#[cfg(test)] mod tests`；跨模块集成测试放 `apps/signaling-rust/tests/`。
> **验收红线**：每步 `cargo fmt --check && cargo clippy -- -D warnings && cargo test` 全绿；前端每步 `pnpm build && pnpm test` 全绿。

---

## 依赖关系总览（blockedBy）

| 任务 | 标题 | blockedBy |
|---|---|---|
| T01 | 项目脚手架与依赖基建 | — |
| T02 | config 默认值与 TOML 反序列化 | T01 |
| T03 | config 三层合并 + 校验 + 脱敏 + ArcSwap 快照 + 单测 | T02 |
| T04 | protocol 消息类型 + classify（静默/error）+ 编解码 + 单测 | T01 |
| T05 | rooms：RoomCode/PeerId + 分片 RoomTable + 单测 | T04 |
| T06 | metrics 注册表与指标命名 | T01 |
| T07 | transport 连接注册表 + per-IP/全局限流 + 有界队列 | T03 |
| T08 | transport 连接生命周期（reader/writer/心跳/假死） | T05, T07 |
| T09 | relay 跨节点消息 + Redis 房间注册（Lua/SETNX/TTL）+ 退避重连 | T03, T05 |
| T10 | http 静态托管（MIME/SPA fallback/403/404/目录回退） | T03 |
| T11 | http 端点（/healthz、/config、CORS、body limit、router 组装） | T03, T05, T06 |
| T12 | admin 模块（Bearer 常量时间认证 + GET/POST /admin/config） | T03 |
| T13 | WS 端点集成 + 路由决策表落地（接入 rooms + relay） | T08, T09, T11 |
| T14 | 热重载（SIGHUP + /admin/config 应用 + 日志级别动态） | T12, T03 |
| T15 | 优雅关闭与信号处理 | T13 |
| T16 | 集成测试（WS 全流程 + 跨节点仿真 + 静默分支） | T13, T09 |
| T17 | 前端 ICE 动态化改造 + 单测 | T11 |
| T18 | Docker 多架构 + compose + 部署文档 | T13 |

---

## T01 · 项目脚手架与依赖基建

- **涉及文件**：
  - `apps/signaling-rust/Cargo.toml`
  - `apps/signaling-rust/src/main.rs`（入口骨架：初始化 tracing、加载配置、占位启动）
  - `apps/signaling-rust/src/lib.rs`（库根：`pub mod config; pub mod protocol; ...` 声明 + `AppState` 占位）
  - `apps/signaling-rust/config.example.toml`（PRD §5.2 全量键示例）
  - `apps/signaling-rust/.dockerignore`
  - `apps/signaling-rust/rust-toolchain.toml`（固定 stable）
  - `.gitignore`（追加 `apps/signaling-rust/target/`）
- **输入**：`architecture.md` §2 模块划分、§10 依赖清单
- **产出与验收**：
  - `cargo build` 成功；`cargo fmt --check` / `cargo clippy -- -D warnings` 零警告
  - 所有模块目录/空文件就位（`config/`、`protocol/`、`transport/`、`rooms/`、`relay/`、`admin/`、`metrics/`、`http/`）
  - `main.rs` 能打印一行启动日志后退出（占位）
- **依赖**：无

## T02 · config 默认值与 TOML 反序列化

- **涉及文件**：
  - `apps/signaling-rust/src/config/mod.rs`（`Config` 结构体 + `Default` + 子结构）
  - `apps/signaling-rust/src/config/defaults.rs`（内置默认值，含默认 STUN 列表）
  - `apps/signaling-rust/src/config/file.rs`（TOML 反序列化：全字段 `Option` 的 partial 结构 + overlay）
  - `apps/signaling-rust/src/config/env.rs`（环境变量名常量与映射骨架）
- **输入**：PRD §5.2 配置总表（逐键逐默认值）、`architecture.md` §3.5 类图
- **产出与验收**：
  - 仅内置默认值即可构造合法 `Config`（默认端口 3000、host 0.0.0.0、ping 30s、idle 60s、handshake 10s、drain 15s、max_conn 100000、max_conn_per_ip 10、max_rooms 50000、max_message 65536、redis url/pool 16/channel_prefix/connect_timeout 5000/room_ttl 3600、log info/text、默认 STUN 四地址、admin token 空）
  - `config.example.toml` 能被 `file.rs` 完整反序列化（往返一致）
  - 单测：默认值断言 + example.toml 解析断言
- **依赖**：T01

## T03 · config 三层合并 + 校验 + 脱敏 + ArcSwap 快照 + 单测

- **涉及文件**：
  - `apps/signaling-rust/src/config/mod.rs`（`Config::load()`、`ConfigSnapshot(ArcSwap<Config>)`、`validate()`、`redacted()`）
  - `apps/signaling-rust/src/config/env.rs`（环境变量覆盖实现：`GOMOKU_*`，数组逗号分隔）
  - `apps/signaling-rust/src/config/reload.rs`（`reload() -> ReloadReport{applied, restart_required}` 骨架）
  - `apps/signaling-rust/tests/config_merge.rs`（**必测项**：三层优先级）
- **输入**：PRD §5.1 合并规则、§5.3 热重载边界；`architecture.md` §9.3
- **产出与验收**：
  - 三层合并：默认值 < `config.toml` < 环境变量，**后者覆盖前者**（含数组与数值类型）
  - fail-fast：端口越界、超时为 0/负、URL 非法 → `ConfigError::Invalid{key,reason}` 明确错误
  - 脱敏：`turn_credential`/`admin_token`/`redis_url` 内嵌密码 → `***`（日志与 `redacted()`）
  - 单测：默认值 / TOML 覆盖 / 环境变量再覆盖 / 非法值报错 / 脱敏输出
- **依赖**：T02

## T04 · protocol 消息类型 + classify（静默/error）+ 编解码 + 单测

- **涉及文件**：
  - `apps/signaling-rust/src/protocol/mod.rs`（`Classification`、`classify()`、`coerce_str/coerce_opt_str/is_falsy`、`ServerMsg`、`encode()`）
  - `apps/signaling-rust/src/protocol/messages.rs`（5 条错误文案常量 + 6 类服务端消息构造器）
  - `apps/signaling-rust/tests/protocol_codec.rs`（**必测项**：编解码往返 + 静默/error 分支）
- **输入**：PRD §4.2/§4.3/§4.5；`packages/shared/src/types.ts` 逐字段对齐；`architecture.md` §9.5/§9.6/§9.7
- **产出与验收**：
  - `ServerMsg` 序列化字段与 TS 类型逐字一致：`created{room,peerId}`、`joined{room,peerId}`、`peer-joined{peerId,name}`、`peer-left{}`、`signal{data}`、`error{message}`
  - `classify` 分支：坏 JSON→Ignore；非对象/缺 `t`/`t` 非字符串→Ignore；`signal` 的 `data` falsy(null/false/0/"")→Ignore；未知 `t`→UnknownType；四类正常解析
  - `name` 截断按 **char** 取 20（多字节安全）；`data` 不透明透传
  - 单测：`created/joined/...` 序列化字符串精确断言；`classify` 每个分支 ≥1 用例（含中文 name 截断）
- **依赖**：T01

## T05 · rooms：RoomCode/PeerId + 分片 RoomTable + 单测

- **涉及文件**：
  - `apps/signaling-rust/src/rooms/mod.rs`（`RoomTable` 分片锁、`Room`、`ConnHandle`、`create/join/signal_targets/leave/len`）
  - `apps/signaling-rust/src/rooms/code.rs`（`RoomCode` 生成/大写化/`^[A-Z0-9]{4}$` 校验；`PeerId` 8 位 base36）
  - `apps/signaling-rust/tests/rooms_state.rs`（**必测项**：房间状态机含 error 与静默分支）
- **输入**：PRD §4.2；`architecture.md` §3.1/§9.4
- **产出与验收**：
  - `RoomTable` 无全局长锁（`SHARD_COUNT=64` 分片 `RwLock`），`room_count: AtomicU64`
  - `create`：已存在→`Exists`；`join`：不存在→`NotFound`、≥2→`Full`；`leave`：返回 `remaining` + `destroyed`
  - `signal_targets` 返回除发送者外成员
  - `RoomCode::new`：入参大写化 + 格式校验；生成器冲突重试上限
  - 单测：create/join/leave 全分支（Exists/NotFound/Full/destroyed）+ `signal_targets` + 房间号大小写与非法格式 + peerId 格式
- **依赖**：T04

## T06 · metrics 注册表与指标命名

- **涉及文件**：
  - `apps/signaling-rust/src/metrics/mod.rs`（`Metrics::new()` + `render() -> String`）
  - `apps/signaling-rust/src/metrics/names.rs`（六类指标名常量）
  - `apps/signaling-rust/src/metrics/middleware.rs`（HTTP 计数中间件占位）
- **输入**：PRD §6.2；`architecture.md` §11 命名约定
- **产出与验收**：
  - `gomoku_ws_connections`(gauge)、`gomoku_rooms`(gauge)、`gomoku_messages_total{type}`(counter)、`gomoku_errors_total{kind}`(counter)、`gomoku_signal_latency_seconds`(histogram)、`gomoku_redis_connected`(gauge)
  - `render()` 输出合法 Prometheus text
  - 单测：指标名与类型断言 + `render()` 含各指标
- **依赖**：T01

## T07 · transport 连接注册表 + per-IP/全局限流 + 有界队列

- **涉及文件**：
  - `apps/signaling-rust/src/transport/mod.rs`（`ConnHandle`、`spawn_connection` 签名骨架）
  - `apps/signaling-rust/src/transport/registry.rs`（`ConnectionRegistry`：全局 `AtomicU64` + `DashMap<IpAddr, AtomicU32>` + `admit()` + RAII `ConnAdmission`）
  - `apps/signaling-rust/src/transport/queue.rs`（连接级有界 `mpsc` 封装 + `try_send` 背压策略 + 慢客户端断开）
- **输入**：PRD §3.2/§6.4；`architecture.md` §3.2/§5.3
- **产出与验收**：
  - `admit(ip)`：`Admitted`/`RejectedGlobal`/`RejectedPerIp`；超限**不分配**资源
  - RAII `ConnAdmission` drop 时 `global-=1`、`per_ip-=1`（无泄漏）
  - 有界队列：`try_send` `Full` → 标记慢客户端（返回可断开信号），**禁止** `unbounded_channel`
  - 单测：全局上限、per-IP 上限、计数增减对称、队列满触发断开
- **依赖**：T03

## T08 · transport 连接生命周期（reader/writer/心跳/假死）

- **涉及文件**：
  - `apps/signaling-rust/src/transport/connection.rs`（reader task：读帧→classify→路由；writer task：队列→sink；共享 `last_seen`）
  - `apps/signaling-rust/src/transport/heartbeat.rs`（ping 定时器 + 假死判定 `now-last_seen >= idle`）
  - `apps/signaling-rust/src/transport/router.rs`（消息路由决策表落地：create/join/signal/leave 分支骨架，依赖 rooms/relay trait）
- **输入**：`architecture.md` §4、§5.1/§5.2
- **产出与验收**：
  - reader 更新 `last_seen`（Pong/Message）；writer 持有 ping interval，假死→Close(1001)
  - 出站全部经有界队列 `try_send`
  - `ConnectionGuard`（RAII）drop 时触发 `leave` + 计数回收
  - 单测：心跳假死计时（注入假时钟）、`last_seen` 更新、路由分支（用假 rooms/relay）
- **依赖**：T05, T07

## T09 · relay 跨节点消息 + Redis 房间注册（Lua/SETNX/TTL）+ 退避重连

- **涉及文件**：
  - `apps/signaling-rust/src/relay/mod.rs`（`RelayManager::{publish, subscribe_room, unsubscribe_room}`；publisher 连接池）
  - `apps/signaling-rust/src/relay/message.rs`（`CrossNodeMsg{v,room,from_node,from_peer,kind,target,name?,payload?}` 编解码）
  - `apps/signaling-rust/src/relay/registry.rs`（`RedisRoomRegistry::{create,join,leave}` + 3 个 Lua 脚本 + 结果枚举）
  - `apps/signaling-rust/src/relay/subscriber.rs`（subscriber task：动态 SUBSCRIBE/UNSUBSCRIBE + 指数退避重连 1s→30s）
- **输入**：PRD §3.4/§6.4；`architecture.md` §3.4/§6.2/§7
- **产出与验收**：
  - Lua：`create`（SET NX EX + SADD + EXPIRE）、`join`（EXISTS/SCARD<2/SADD）、`leave`（SREM + 空则 DEL）
  - key：`{prefix}:room:{CODE}`、`{prefix}:room:{CODE}:members`、channel `{prefix}:room:{CODE}`
  - 退避重连：1s→30s；断线期 `gomoku_redis_connected=0`，降级不崩溃
  - `LocalDelivery` trait 注入（依赖反转），relay 不直接依赖 transport 具体类型
  - 单测：`CrossNodeMsg` 往返；Lua 脚本行为用 mock 客户端（或集成测试连本地 Redis，标记 `#[ignore]` 可选跑）
- **依赖**：T03, T05

## T10 · http 静态托管（MIME/SPA fallback/403/404/目录回退）

- **涉及文件**：
  - `apps/signaling-rust/src/http/mod.rs`（模块声明 + `AppState`）
  - `apps/signaling-rust/src/http/static_files.rs`（自定义静态处理器：路径规范化 + `starts_with` 403 + SPA fallback + 目录回退探测）
  - `apps/signaling-rust/src/http/mime.rs`（MIME 表，含 `.mjs`）
- **输入**：`apps/server/src/server.ts` 行为基准；`architecture.md` §9.9
- **产出与验收**：
  - `public_dir` 回退探测顺序：`[配置值, packages/web/dist, dist, public]`
  - MIME 含 `.mjs → text/javascript; charset=utf-8`；一律 `cache-control: no-cache`
  - 路径穿越 → **403 Forbidden**；无扩展名 404 → 回退 `index.html`；有扩展名 404 → 404
  - 单测：MIME 映射、路径穿越拒绝、SPA fallback、缺失文件 404（用临时目录）
- **依赖**：T03

## T11 · http 端点（/healthz、/config、CORS、body limit、router 组装）

- **涉及文件**：
  - `apps/signaling-rust/src/http/router.rs`（axum `Router` 组装 + CORS + `RequestBodyLimitLayer` + trace）
  - `apps/signaling-rust/src/http/health.rs`（`GET /healthz` → `{ok:true, rooms, uptime}`）
  - `apps/signaling-rust/src/http/config_endpoint.rs`（`GET /config` → `{iceServers:[...]}`，TURN 段按 `turn_url`/`turn_credential_exposed` 显隐，`Cache-Control: no-cache`）
- **输入**：PRD §4.4；`architecture.md` §12-Q1
- **产出与验收**：
  - `/healthz` 字段/类型与 v1 一致，`rooms` 实时取 `RoomTable::len()`
  - `/config` 返回标准 `RTCIceServer[]` 形状；TURN 段仅当配置 `turn_url` 且 `turn_credential_exposed` 出现
  - CORS：`origins` 空→不加 CORS 头（同源）；非空→白名单
  - body limit = `max_message_bytes`（HTTP 侧防护）
  - 单测：`/healthz` 字段、`/config` TURN 显隐、CORS 空/非空行为
- **依赖**：T03, T05, T06

## T12 · admin 模块（Bearer 常量时间认证 + GET/POST /admin/config）

- **涉及文件**：
  - `apps/signaling-rust/src/admin/mod.rs`（`admin_router()` + 路由注册）
  - `apps/signaling-rust/src/admin/auth.rs`（`subtle` 常量时间比较；token 空 → 404 禁用）
  - `apps/signaling-rust/src/admin/handlers.rs`（`GET /admin/config` 脱敏视图；`POST /admin/config` → `{applied,restart_required}`；400 校验失败；401 令牌错）
- **输入**：PRD §4.4/§3.2；`architecture.md` §9.3/§12-Q2
- **产出与验收**：
  - token 未配置 → `/admin/*` 返回 404；令牌错 → 401；正确 → 200
  - `GET` 返回脱敏配置（`turn_credential`/`admin_token`/`redis_url` 密码 = `***`）
  - `POST` 返回 `applied`（可热改项）与 `restart_required`（host/port/public_dir/redis_url）
  - 单测：认证 404/401/200、脱敏输出、POST 校验失败 400
- **依赖**：T03

## T13 · WS 端点集成 + 路由决策表落地

- **涉及文件**：
  - `apps/signaling-rust/src/http/ws.rs`（`GET /signal` 升级：admit 准入 → 握手超时 → spawn 连接 task）
  - `apps/signaling-rust/src/transport/router.rs`（补全路由决策：create/join/signal/leave 接入 `RoomTable` + `RelayManager` + `RedisRoomRegistry`）
  - `apps/signaling-rust/src/http/mod.rs`（把 `/signal` 挂进 router；`AppState` 注入 rooms/relay/metrics/shutdown）
- **输入**：`architecture.md` §4.3/§5.2/§6.2
- **产出与验收**：
  - 端到端：未改客户端跑通 建房→加入→peer-joined→signal×N→leave→peer-left
  - 5 条 error 文案逐字一致；静默行为（坏 JSON/缺 t/falsy data）精确复刻
  - 重复建房/加入先离旧房（旧房对端收 peer-left）
  - `create`/`join` 走 Redis 全局唯一（降级时回退本地）
  - 依赖：T08, T09, T11

## T14 · 热重载（SIGHUP + /admin/config 应用 + 日志级别动态）

- **涉及文件**：
  - `apps/signaling-rust/src/config/reload.rs`（读文件+env → 合并 → 校验 → diff → `ArcSwap::store`）
  - `apps/signaling-rust/src/main.rs`（SIGHUP 监听 → 触发 reload）
  - `apps/signaling-rust/src/admin/handlers.rs`（`POST /admin/config` 接入 reload，返回 applied/restart_required）
- **输入**：PRD §5.3；`architecture.md` §9.3
- **产出与验收**：
  - SIGHUP / `POST /admin/config` 修改日志级别、limits、CORS、STUN/TURN 生效**不重启**
  - `host/port/public_dir/redis_url` 变更标记 `restart_required`
  - 非法配置拒绝应用并保留旧快照（不崩溃）
  - 单测：reload diff 计算（applied vs restart_required）、非法拒绝
- **依赖**：T12, T03

## T15 · 优雅关闭与信号处理

- **涉及文件**：
  - `apps/signaling-rust/src/transport/shutdown.rs`（`Shutdown` 令牌 + 排空：广播→等待≤drain→强制 abort）
  - `apps/signaling-rust/src/main.rs`（SIGTERM/SIGINT → 停 accept → cancel → 排空 → 退出；`with_graceful_shutdown`）
  - `apps/signaling-rust/src/transport/connection.rs`（连接 task 响应 shutdown 发 Close(1001)）
- **输入**：PRD §3.1 R10/§6.4；`architecture.md` §4.4
- **产出与验收**：
  - SIGTERM 后 ≤ `shutdown_drain_secs` + 5s 退出；退出前存量连接收到 Close 通知
  - 排空期拒绝新连接
  - 单测：排空超时强制退出（注入假时钟 + 假连接）
- **依赖**：T13

## T16 · 集成测试（WS 全流程 + 跨节点仿真 + 静默分支）

- **涉及文件**：
  - `apps/signaling-rust/tests/integration_ws.rs`（建房→加入→信令→离开全流程；5 条 error；静默分支）
  - `apps/signaling-rust/tests/support/client.rs`（测试用 WS 客户端封装）
  - `apps/signaling-rust/tests/support/fake_relay.rs`（假 `LocalDelivery` + 假 Redis registry，无网仿真跨节点）
- **输入**：PRD §7 DoD；`architecture.md` §5/§6
- **产出与验收**：
  - 单节点全流程通过；error 文案逐字断言；坏 JSON/缺 t/falsy data 无响应
  - 跨节点仿真：A 建房 B 加入成功牵手；signal/peer-left 双向可达；同码跨节点建房被拒
  - 静态/`/healthz`/`/config` 冒烟
- **依赖**：T13, T09

## T17 · 前端 ICE 动态化改造 + 单测

- **涉及文件**：
  - `packages/web/src/iceConfig.ts`（新增：`fetchIceServers(fetchFn)` 从 `GET /config` 取 `iceServers`；**失败降级**到内置默认 STUN；`fetchFn` 参数注入以便单测）
  - `packages/web/src/webrtc.ts`（移除硬编码 `ICE_SERVERS`；`initPeer(isInitiator, iceServers)` 接收参数；保留 `DEFAULT_ICE_SERVERS` 仅作降级）
  - `packages/web/src/App.tsx`（挂载时加载 ICE 配置，失败时降级继续可用，**不阻塞零服务器路径**）
  - `packages/web/test/iceConfig.test.ts`（单测：成功解析、`/config` 失败降级、TURN 段可选）
- **输入**：PRD §3.1 R5/§附；`architecture.md` §12-Q1
- **产出与验收**：
  - `/config` 可用 → 使用服务端下发 `iceServers`（含 TURN 时）
  - `/config` 不可用 → 降级内置 STUN，页面**不崩**（保底原则）
  - 协议代码零改动（仅 ICE 来源变化）
  - `pnpm build && pnpm test` 全绿；改 web 追加 `pnpm test:e2e`
- **依赖**：T11

## T18 · Docker 多架构 + compose + 部署文档

- **涉及文件**：
  - `apps/signaling-rust/Dockerfile`（多阶段构建；`buildx` amd64/arm64；非 root 运行；`HEALTHCHECK` 走 `/healthz`）
  - `apps/signaling-rust/docker-compose.yml`（一键起服务 + Redis；挂载 config.toml）
  - `apps/signaling-rust/README.md`（Rust 版与 Node fallback 切换、负载均衡前置无需 sticky、环境变量清单）
  - `docs/m3-rust-signaling/deploy.md`（部署与运维：探针、优雅关闭、Redis 形态、内核参数建议）
- **输入**：PRD §3.1 R8/§6.1；`architecture.md` §6.3/§12-Q8
- **产出与验收**：
  - `docker buildx build --platform linux/amd64,linux/arm64` 成功
  - `docker compose up` 一键起服务 + Redis；`HEALTHCHECK` 通过
  - 容器非 root；文档说明无需 sticky session
- **依赖**：T13

---

## 共享知识（Engineer 必读）

- **协议冻结**：WS 消息集合、字段名、错误文案**不得新增/修改**（PRD §4.1）。`protocol` 是 Rust 侧唯一定义源，与 `packages/shared/src/types.ts` 对齐。
- **配置契约**：PRD §5.2 键名/环境变量名/默认值为契约；新增键（如 `broadcast_queue_capacity`、`turn_credential_exposed`、`allowed_ws_origins`）需回签 PRD（见 `architecture.md` §12-Q6）。
- **依赖方向**：`protocol ◄ rooms ◄ transport ◄ http ◄ main`；`config`/`metrics` 为叶子；`relay` 经 `LocalDelivery` trait 回投，禁止反向依赖。
- **热路径红线**：无 `unwrap`、无 `info!`/`println!`、无磁盘 IO、无 `unbounded_channel`。
- **脱敏**：`turn_credential`/`admin_token`/`redis_url` 密码一律 `***`。
- **错误文案常量**：集中在 `protocol::messages`，禁止散落字符串。
- **测试对称**：`src/<module>` ↔ `tests/<module>_*.rs`；每个失败分支 ≥1 用例（Exists/NotFound/Full/坏 JSON/缺 t/falsy data）。
- **指标命名**：`gomoku_` 前缀（§11）。
- **时间**：`uptime` 为秒；内部用 `Instant`/`Duration`。

---

## 验收映射（DoD → 任务）

| DoD 项 | 覆盖任务 |
|---|---|
| ① 协议兼容全流程 + 5 error + 静默 | T04, T13, T16 |
| ② 跨节点牵手 + 同码拒绝 | T09, T16 |
| ③ 三层配置 | T02, T03 |
| ④ `/config` + 客户端降级 | T11, T17 |
| ⑤ `/healthz` | T11 |
| ⑥ Docker 多架构 + compose | T18 |
| ⑦ 优雅关闭 | T15 |
| ⑧ 静态托管行为一致 | T10 |
| ⑨ 工程质量（fmt/clippy/test） | 全部任务 |
| ⑩ `/metrics` 六类指标 | T06, T11 |
| ⑪ 热重载 | T14 |
| ⑫ 压测报告（P2） | 后续（非本任务集） |
| ⑬ 多架构 CI（P2） | 后续（非本任务集） |
