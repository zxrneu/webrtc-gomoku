# M3 v2.0 · Rust 信令服务器 PRD

| 项 | 内容 |
|---|---|
| 里程碑 | M3 · v2.0（ROADMAP.md） |
| 作者 | 许清楚（Xu）· 产品经理 |
| 状态 | 待评审（架构师 / 工程师 / QA 会签） |
| 语言 | 中文 |
| 编程语言 | Rust（tokio + axum + tokio-tungstenite）+ Redis pub/sub |
| 项目名称 | `gomoku-signaling-rust`（monorepo 内落点由架构师定，建议 `apps/signaling-rust` 或 `rust/`） |
| 原始需求复述 | 将 M3 v2.0 信令服务器用 Rust 重写：支持单机 10 万+ WebSocket 长连接与万人级并发房间；全部可调参数经外部配置文件加载、禁止硬编码；明确架构/模块/核心数据结构需求；涵盖连接管理、消息路由、负载均衡与容错；给出性能优化策略要求；代码结构清晰、符合 Rust 最佳实践 |

---

## 1. 背景与目标

### 1.1 背景

- **产品第一原则**（ROADMAP）：单文件 HTML「零服务器 + 微信互发连接码」永远是可用的保底路径。信令服务器**仅在启用「房间联机」（自动牵线）时才需要**，M3 不得破坏该原则。
- **现状**：Node（ws）信令服务器 `apps/server/src/server.ts`（M2 TS 版，信令消息类型来自 `@webrtc-gomoku/shared`）。根目录遗留单文件 `server.js` 与根 `Dockerfile` 已移除，Node 版不再有第二份实现。
- **职责边界**：服务器只做两件事——① 托管静态页面；② 按房间中转 WebRTC 信令（offer/answer/ice）。**棋局数据全部走浏览器之间 DataChannel，永不经过服务器。**
- **痛点**：Node 单机长连接规模受限；配置靠 `PORT/HOST` 环境变量硬编码；无指标、无热重载、无跨节点能力，无法水平扩展。
- **M3 v2.0**：Rust 重写，目标单机 10 万+ WS 长连接、万人级并发房间、全配置化、可水平扩展。

### 1.2 M3 在 ROADMAP 中的定位

```
M1 体验增强 → M2 TS 工程化 → M3 Rust 信令服务器 → M4 多端分发与变现
```

- M3 是 **M4 小程序路径 B（WS 中继）的地基**（ROADMAP R6 结论：优先复用 M3 信令服务器）。
- **R7（Rust 重写与现有 WS 协议兼容性）在本里程碑结案**。
- M3 上线后 Node 版 `apps/server` 保留为 fallback，直至 Rust 版稳定。

### 1.3 产品目标（3 个正交）

| # | 目标 | 衡量 |
|---|---|---|
| G1 | **协议零感知迁移**：WS v1 协议 100% 兼容 | 现有客户端零改动跑通建房-加入-信令-离开全流程；error 文案逐字一致 |
| G2 | **高并发与水平扩展** | 单机 10 万+ 长连接、万人级并发房间；Redis pub/sub 跨节点牵线 |
| G3 | **可运维可配置** | 三层配置合并、热重载不重启、/healthz + /metrics 可观测、Docker 多架构交付 |

### 1.4 范围声明

- **In scope**：Rust 信令服务（HTTP / WS / 静态托管 / /config / /metrics / /admin）；Redis 跨节点中转；三层配置；Docker 多架构；客户端 ICE 配置动态化改造（`packages/web`）；压测报告。
- **Out of scope**：TURN 自建/租用（M3 仅做配置下发，ROADMAP 已后置）；TLS 终止（P2 占位）；棋步 WS 中继（M4 路径 B 才启用，但架构需预留）；限流精细化（P2）。

---

## 2. 用户故事

### 部署者

- **US-1**：作为部署者，我想通过 `config.toml` + 环境变量完成全部配置（端口/超时/并发上限/Redis/STUN/TURN/CORS/管理令牌），以便同一镜像在本机、Docker、K8s 环境零改代码部署。
- **US-2**：作为部署者，我想改配置不重启进程（SIGHUP 或 `/admin/config`），以便调整日志级别、连接上限不中断在线对局。
- **US-3**：作为部署者，我想 STUN/TURN 通过环境变量导入后由 `GET /config` 自动下发给页面，以便更换 TURN 服务商只改服务器配置、不发新前端版本。

### 玩家

- **US-4**：作为玩家，我想创建房间拿到 4 位房间号、对方输入即可加入并自动牵线，以便像现在一样快速开局。
- **US-5**：作为玩家，我想对局中途对方掉线时立刻看到「对方已离开」，以便决定等待或重开。
- **US-6**：作为玩家，我想即使和对手落在不同服务器节点也能正常牵手，以便服务扩容后体验不变。

### 运维

- **US-7**：作为运维，我想用 `/healthz` 做存活探针、用 `/metrics` 观察连接数/房间数/消息量，以便监控与告警。
- **US-8**：作为运维，我想滚动发布时旧节点优雅关闭（排空存量连接），以便不主动掐断正在信令阶段的连接。

---

## 3. 需求池

### 3.1 P0（MVP 必做）

| # | 需求 | 说明 |
|---|---|---|
| R1 | **WS 信令协议 v1 完全兼容** | `create/join/signal/leave` + 6 类服务器消息 + 5 种 error 文案逐字一致（见 §4） |
| R2 | **房间管理** | 4 位 `[A-Z0-9]` 房间号（缺省生成、入参大写化、格式校验、全局唯一）；1v1 容量；name 截断 20 字符；peerId 8 位 base36；幽灵房间清理（重复建房先离旧房；房间空即毁） |
| R3 | **静态托管** | MIME（含 `.mjs`）、`cache-control: no-cache`、SPA fallback（无扩展名路径回退 `index.html`）、路径穿越 403、其余 404 |
| R4 | **三层配置** | 内置默认值 < `config.toml` < 环境变量；启动打印生效配置（脱敏）；非法配置 fail-fast 并给出明确错误 |
| R5 | **`GET /config`** | 向页面下发 `iceServers`（STUN 列表 + 可选 TURN）；客户端 `ICE_SERVERS` 去硬编码改为动态获取，含失败降级 |
| R6 | **`GET /healthz`** | 返回 `{ok, rooms, uptime}`，与 v1 字段/类型一致 |
| R7 | **Redis pub/sub 跨节点中转** | 同房间两人跨节点可牵手（`peer-joined/signal/peer-left` 跨节点可达）；房间号全局唯一（SETNX + TTL），防止同码房间落在不同节点 |
| R8 | **Docker** | amd64/arm64 多架构镜像；非 root 运行；HEALTHCHECK 走 `/healthz`；compose 一键起服务 + Redis |
| R9 | **心跳与假死清理** | WS ping 周期可配（默认 30s）；连续无 pong 断开（默认 60s，对齐 v1 两个 ping 周期行为） |
| R10 | **优雅关闭** | SIGTERM/SIGINT → 停止 accept → 排空存量（默认 15s）→ 通知并关闭 → 退出 |
| R11 | **基础防护** | 消息大小上限（默认 64KB）、每 IP 连接上限（默认 10）、WS 握手超时（默认 10s） |

### 3.2 P1（应该做）

| # | 需求 | 说明 |
|---|---|---|
| R12 | **`/metrics`（Prometheus）** | 指标清单见 §6.2 |
| R13 | **热重载** | SIGHUP + `POST /admin/config`（Bearer 令牌）；除监听地址/端口外全部参数可热改 |
| R14 | **管理 API** | `GET /admin/config` 查看生效配置（脱敏）；POST 返回 `applied` / `restart_required` 字段清单 |
| R15 | **CORS 白名单** | `GOMOKU_CORS_ORIGINS`；为空 = 仅同源 |
| R16 | **结构化日志** | tracing；级别/格式可配；日志级别支持热改 |
| R17 | **部署文档** | README/docs 说明 Rust 版与 Node fallback 的切换方式、负载均衡前置（无需 sticky session） |

### 3.3 P2（Nice to have）

| # | 需求 | 说明 |
|---|---|---|
| R18 | **压测报告** | 10 万连接稳定性、跨节点牵手、延迟分布，归档 `docs/m3-rust-signaling/benchmark.md` |
| R19 | **多架构 CI** | push 触发 buildx amd64/arm64 自动构建 |
| R20 | **TLS 终止** | 内置 rustls 或文档化反代方案 |
| R21 | **限流精细化** | 每连接消息速率限制、每 IP 建房频率限制 |
| R22 | **运行时参数配置化** | tokio worker 线程数等 |

### 3.4 架构与代码结构需求（移交架构师）

**模块划分要求**（建议，架构师可调整）：

| 模块 | 职责 |
|---|---|
| `config` | 三层合并、schema 校验、热重载快照（`ArcSwap` 或等价无锁读） |
| `protocol` | v1 消息 serde 类型唯一定义源，与 `packages/shared/src/types.ts` 逐字段对齐 |
| `transport` | WS 连接生命周期、心跳、有界广播队列（背压） |
| `rooms` | 本节点房间表与成员索引 |
| `relay` | Redis pub/sub 编解码、跨节点消息路由、房间注册 TTL |
| `admin` | 令牌认证、管理 API |
| `metrics` | Prometheus 注册表与中间件 |
| `http` | axum router、静态文件、SPA fallback |

**核心数据结构要求**：

1. **房间表**：O(1) 按房间号查找；10 万连接下**无全局长锁**（分片锁或无锁 map，读多写少）；成员集合 ≤2（1v1）。
2. **连接注册表**：支持 per-IP 计数与全局限流；连接级**有界**广播队列——慢客户端主动断开，禁止无限缓冲（OOM 防护）。
3. **计数器**：`AtomicU64`（连接数/消息数/错误数），热路径无锁。
4. **房间注册表（Redis）**：`SETNX gomoku:signal:room:{CODE}` + TTL（默认 3600s，建房/加入刷新），节点宕机后 TTL 自然回收，防幽灵房间。
5. **跨节点消息**：按房间号 channel（或单 channel + 房间号路由，架构师定）；消息体含房间号、目标 peerId、发送方 node_id、原始 payload；**服务器不解析信令 payload 内容**。

**性能优化策略要求**（实现说明由架构师/工程师落笔）：

- 每连接独立 tokio task，单连接 panic 不波及其他（task 隔离）。
- 信令转发热路径零日志、零磁盘 IO；`serde_json` 严格模式；消息进出均做大小校验。
- 广播使用有界 channel；背压策略 = 断开慢客户端而非堆积。
- Redis 连接池 + 断线指数退避重连（初始 1s、上限 30s）；重连期本节点功能降级不崩溃。
- 连接建立/销毁走原子计数；房间事件才写 info 日志。

**代码质量要求**：`cargo fmt` / `cargo clippy` 零警告；错误类型分层（`thiserror` 领域错误）；热路径无 `unwrap`；每模块单测（配置合并、协议编解码、房间状态机为必测项）。

---

## 4. 协议与 API 契约

### 4.1 v1 兼容性声明（协议冻结）

下表描述 v1 兼容基线。当前 Node / Rust 还支持重连协议中的 `ping`、`pong`、`resume`、`resumed`、`peer-offline`、`peer-online`，以及可选的座位凭证与错误码；具体契约见[重连协议设计](../reconnect/architecture.md#4-协议增量设计v11)和 `packages/shared/src/types.ts`。大厅增量见[大厅需求](../m6-lobby/prd.md)。

| 维度 | 约束 |
|---|---|
| 帧格式 | JSON **文本帧**；不引入二进制帧、不引入子协议扩展 |
| 消息集合 | v1 消息类型即完整集合，M3 **不新增 WS 消息类型**（跨节点/配置下发对客户端透明） |
| 语义 | 全部字段名、字段类型、错误文案与 v1 逐字一致 |
| 旧行为精确复刻 | ① 无法解析的 JSON 或缺字符串 `t` → **静默忽略**（不回 error）；② `signal` 的 `data` 为 falsy（缺失/`null`/空串）→ 静默丢弃；③ `create`/`join` 时已在房 → **先离开旧房**（旧房对端收到 `peer-left`）；④ 未知 `t` → `error` |
| 连接路径 | `/signal`（不变） |

### 4.2 客户端 → 服务器（WS）

| `t` | 载荷 | 行为与校验 |
|---|---|---|
| `create` | `{t:'create', room?}` | `room` 缺省 → 服务端生成 4 位 `[A-Z0-9]`（冲突重试）；提供 → 大写后须匹配 `^[A-Z0-9]{4}$`，否则 `error`「房间号需为 4 位字母或数字」；**全局**已存在 → `error`「房间 {CODE} 已存在，请更换」；成功 → `created` |
| `join` | `{t:'join', room, name?}` | 大写 + 同格式校验；不存在 → `error`「房间 {CODE} 不存在」；已满 2 人 → `error`「房间已满（仅支持 1v1）」；`name` 截断 20 字符；成功 → `joined`，并通知房内另一人 `peer-joined` |
| `signal` | `{t:'signal', data}` | 发送方须在房中（否则静默忽略）；`data` falsy 忽略；转发给房内另一成员——同节点直投，跨节点经 Redis pub/sub |
| `leave` | `{t:'leave'}` | 离开房间；房内另一人收到 `peer-left`；房间空则销毁 |
| 其他 | — | `error`「未知消息类型」 |

### 4.3 服务器 → 客户端（WS）

| `t` | 载荷 | 字段说明 |
|---|---|---|
| `created` | `{t:'created', room, peerId}` | 建房成功 |
| `joined` | `{t:'joined', room, peerId}` | 加入成功 |
| `peer-joined` | `{t:'peer-joined', peerId, name}` | 对端加入；`name` 缺省为空串 |
| `peer-left` | `{t:'peer-left'}` | 对端离开（含掉线清理） |
| `signal` | `{t:'signal', data}` | 透传，`data` 为不透明 JSON，服务器不解析 |
| `error` | `{t:'error', message}` | 见 §4.5 文案清单 |

字段类型：`room` = 4 位大写字符串；`peerId` = 8 位 `[a-z0-9]`（与 v1 的 `Math.random().toString(36).slice(2,10)` 格式对齐）；`name` ≤ 20 字符；`data` 任意 JSON；`message` 字符串。

### 4.4 HTTP 端点

| 方法 | 路径 | 认证 | 响应 | 优先级 |
|---|---|---|---|---|
| GET | `/config` | 无 | 200 `{iceServers: RTCIceServer[]}`，`Cache-Control: no-cache` | P0 |
| GET | `/healthz` | 无 | 200 `{ok:true, rooms:number, uptime:number}`（uptime 为秒） | P0 |
| GET | `/metrics` | 无（限内网/不暴露敏感值） | 200 Prometheus text 格式 | P1 |
| GET | `/admin/config` | Bearer `GOMOKU_ADMIN_TOKEN` | 200 生效配置（脱敏）；401 令牌错；未配置令牌时 404 | P1 |
| POST | `/admin/config` | Bearer | 200 `{applied:[...], restart_required:[...]}`；400 校验失败；401 | P1 |
| 静态 | `/*` | 无 | MIME + SPA fallback + 403/404 | P0 |
| WS | `/signal` | 无 | 协议升级 | P0 |

`/config` 响应示例：

```json
{
  "iceServers": [
    { "urls": ["stun:stun.qq.com:3478", "stun:stun.aliyun.com:3478",
               "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
    { "urls": ["turn:turn.example.com:3478"], "username": "user", "credential": "***" }
  ]
}
```

- TURN 段仅当配置了 `turn_url` 时出现；credential 是否明文下发见 **Q1**。
- 该响应即 `RTCIceServer[]` 标准形状，客户端可直接传入 `new RTCPeerConnection({iceServers})`。
- 管理 API 改配置的持久化语义见 **Q2**。

### 4.5 错误文案清单（与 v1 逐字一致）

| 场景 | 行为 |
|---|---|
| JSON 无法解析 / 缺字符串 `t` | 静默忽略，无消息 |
| 未知 `t` | `{t:'error', message:'未知消息类型'}` |
| 房间号格式错误 | `{t:'error', message:'房间号需为 4 位字母或数字'}` |
| 建房冲突 | `{t:'error', message:'房间 {CODE} 已存在，请更换'}`（CODE 为大写房间号） |
| 加入不存在的房间 | `{t:'error', message:'房间 {CODE} 不存在'}` |
| 房间已满 | `{t:'error', message:'房间已满（仅支持 1v1）'}` |

---

## 5. 配置项清单

### 5.1 合并与命名规则

1. **三层合并**（后者优先）：内置默认值 < 配置文件 < 环境变量。
2. **配置文件**：默认 `./config.toml`，可用 `GOMOKU_CONFIG_FILE` 指定路径（扩展项）。
3. **环境变量命名**：`GOMOKU_` + 配置键大写形式；数组用逗号分隔；ROADMAP 已固定的名称优先。
4. **fail-fast**：端口越界、超时为 0/负数、URL 格式错误等 → 启动失败并给出明确错误信息。
5. **脱敏**：`turn_credential`、`admin_token`、`redis_url` 内嵌密码在日志与 `/admin/config` 中一律输出 `***`。

### 5.2 配置项总表

#### [server] 监听

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `host` | string | `"0.0.0.0"` | `GOMOKU_HOST` | 监听地址 |
| `port` | u16 | `3000` | `GOMOKU_PORT` | 监听端口 |
| `public_dir` | string | `"public"` | `GOMOKU_PUBLIC_DIR` | 静态目录；缺失时按 TS 版逻辑回退探测 `packages/web/dist`、`dist` |

#### [timeouts] 超时

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `ws_ping_interval_secs` | u64 | `30` | `GOMOKU_WS_PING_INTERVAL` | WS ping 周期 |
| `ws_idle_timeout_secs` | u64 | `60` | `GOMOKU_WS_IDLE_TIMEOUT` | 无 pong 判定假死并断开（对齐 v1 两个 ping 周期） |
| `ws_handshake_timeout_secs` | u64 | `10` | `GOMOKU_WS_HANDSHAKE_TIMEOUT` | WS 握手超时 |
| `shutdown_drain_secs` | u64 | `15` | `GOMOKU_SHUTDOWN_DRAIN` | 优雅关闭排空时长（v1 为 1.5s，Rust 版延长以保护信令中连接） |

#### [limits] 并发上限

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `max_connections` | u64 | `100000` | `GOMOKU_MAX_CONNECTIONS` | 全节点 WS 长连接上限，超出拒绝新连接 |
| `max_connections_per_ip` | u32 | `10` | `GOMOKU_MAX_CONNECTIONS_PER_IP` | 单 IP 连接上限 |
| `max_rooms` | u32 | `50000` | `GOMOKU_MAX_ROOMS` | 房间数上限（1v1 下 10 万连接 ≈ 5 万房间） |
| `max_message_bytes` | usize | `65536` | `GOMOKU_MAX_MESSAGE_BYTES` | 单消息大小上限（64KB，覆盖 SDP/ICE 载荷） |

#### [redis] 跨节点中转

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `url` | string | `"redis://127.0.0.1:6379"` | `GOMOKU_REDIS_URL` | Redis 连接串（可含认证） |
| `pool_size` | u32 | `16` | `GOMOKU_REDIS_POOL_SIZE` | 连接池大小 |
| `channel_prefix` | string | `"gomoku:signal"` | `GOMOKU_REDIS_CHANNEL_PREFIX` | pub/sub channel 前缀 |
| `connect_timeout_ms` | u64 | `5000` | `GOMOKU_REDIS_CONNECT_TIMEOUT_MS` | 连接超时 |
| `room_ttl_secs` | u64 | `3600` | `GOMOKU_ROOM_TTL` | 房间注册 TTL，建房/加入刷新，防幽灵房间 |

#### [cluster] 集群

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `node_id` | string | `<hostname>-<rand8>` | `GOMOKU_NODE_ID` | 节点标识，进日志与跨节点消息 |
| `nodes` | string[] | `[]` | `GOMOKU_CLUSTER_NODES` | **预留**：节点清单；当前 Redis pub/sub 已满足跨节点，供未来直连优化/管理面展示 |

#### [cors] 跨域

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `origins` | string[] | `[]` | `GOMOKU_CORS_ORIGINS` | 允许的来源白名单；空 = 仅同源，不输出 CORS 头 |

#### [logging] 日志

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `level` | string | `"info"` | `GOMOKU_LOG_LEVEL` | `trace/debug/info/warn/error` |
| `format` | string | `"text"` | `GOMOKU_LOG_FORMAT` | `text` / `json` |

#### [ice] STUN/TURN（下发给客户端）

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `stun_servers` | string[] | 见下方默认列表 | `GOMOKU_STUN_SERVERS` | STUN 列表，逗号分隔 |
| `turn_url` | string | `""` | `GOMOKU_TURN_URL` | TURN 地址；空 = 不下发 TURN 段 |
| `turn_username` | string | `""` | `GOMOKU_TURN_USER` | TURN 用户名 |
| `turn_credential` | string | `""` | `GOMOKU_TURN_CREDENTIAL` | TURN 凭证（脱敏存储与展示） |

默认 STUN 列表（对齐现有客户端硬编码，`packages/web/src/webrtc.ts`）：

```
stun:stun.qq.com:3478, stun:stun.aliyun.com:3478,
stun:stun1.l.google.com:19302, stun:stun2.l.google.com:19302
```

#### [admin] 管理面

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `token` | string | `""` | `GOMOKU_ADMIN_TOKEN` | 管理 API 令牌；**空 = 管理面整体禁用（404）** |

### 5.3 热重载边界

- **可热改**：日志级别/格式、CORS、STUN/TURN、limits、超时（不含已建立连接的行为语义变更风险由实现方评估）、Redis 连接参数、admin token。
- **不可热改（需重启，`restart_required`）**：`host`、`port`、`public_dir`、`redis_url`（连接池重建风险，实现方可评估后放宽）。

---

## 6. 非功能需求

### 6.1 性能指标

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 并发长连接 | 单机 ≥ **100,000** WS 长连接（空闲保活），参考硬件 4C8G | 压测（R18） |
| 并发房间 | ≥ **10,000** 活跃房间（1v1） | 压测 |
| 内存预算 | 10 万连接全进程 RSS ≤ **2GB**（单连接 ≤ 16KB 含缓冲）；5 万房间表增量 ≤ 200MB | 压测采样 |
| 信令转发延迟 | 同节点 P99 ≤ **10ms**；跨节点（Redis）P99 ≤ **50ms** | 压测直方图 |
| 信令吞吐 | ≥ **50,000 msg/s/节点**（建房/加入突发不积压） | 压测 |
| 水平扩展 | 加节点即扩容，**无需 sticky session**；节点间无直接依赖（Redis 为唯一共享故障域） | 双节点联调 |

### 6.2 可观测性

`/metrics` 建议指标（Prometheus 命名，架构师可微调）：

| 指标 | 类型 | 说明 |
|---|---|---|
| `gomoku_ws_connections` | gauge | 当前 WS 连接数 |
| `gomoku_rooms` | gauge | 当前房间数 |
| `gomoku_messages_total{type}` | counter | 按消息类型计数 |
| `gomoku_errors_total{kind}` | counter | 按错误类型计数 |
| `gomoku_signal_latency_seconds` | histogram | 信令转发延迟分布 |
| `gomoku_redis_connected` | gauge 0/1 | Redis 连通状态（告警项） |

- 日志：tracing 结构化，每行含 `node_id`；连接生命周期与房间事件记 info；**默认 info 级别不打印逐消息日志**（热路径零日志）。
- `/healthz` 字段与 v1 完全一致（`ok/rooms/uptime`），供 LB 探针复用。

### 6.3 安全

| 面 | 要求 |
|---|---|
| 注入 | 房间号限定 `[A-Z0-9]{4}` 后才进入 Redis key（`gomoku:signal:room:{CODE}`），天然免疫注入；无 SQL；入站 JSON 严格 schema 校验 |
| XSS | 服务器只中转不渲染；`name` ≤ 20 字符；消息大小上限；渲染责任在客户端（现状不变） |
| 令牌 | `/admin/*` Bearer 认证、常量时间比较；未配置 token 时 404 禁用；`/metrics` 不含任何敏感值 |
| 来源校验 | CORS 白名单（默认同源）；WS Origin 校验策略见 **Q3** |
| 静态资源 | 路径穿越 403（复刻 v1 `startsWith` 校验）；不服务 `public_dir` 外任何文件 |
| 资源滥用 | per-IP 连接上限 + 消息大小上限（P0）；每连接消息速率限制（P2，R21） |

### 6.4 容错

- **Redis 断线**：自动重连，指数退避（初始 1s、上限 30s）；重连期间本节点房间/信令不受影响，仅跨节点暂停；`gomoku_redis_connected=0` 触发告警。
- **节点宕机**：对端经 TCP 断开收到 `peer-left`；Redis 房间注册 TTL（默认 3600s）回收，防幽灵房间。
- **进程级隔离**：单连接 task panic 不波及其他连接；广播队列有界，慢客户端主动断开。
- **优雅关闭**：排空期拒绝新连接；存量信令连接待发消息发完后关闭；超时强制退出。

---

## 7. 验收标准（DoD）

**P0 阻塞项（不满足不得合入）：**

1. **协议兼容**：用**未修改**的 `packages/web` 客户端跑通 建房 → 加入 → `peer-joined` → `signal`×N → `leave` → `peer-left` 全流程；5 种 error 场景文案逐字一致；v1 静默行为（坏 JSON / 缺 `t` / falsy `data`）精确复刻。
2. **跨节点**：两实例 + Redis，A 建房 B 加入成功牵手；`signal`/`peer-left` 双向跨节点可达；同码房间跨节点建房被拒（全局唯一）。
3. **三层配置**：仅默认值启动 OK；`config.toml` 覆盖生效；同名环境变量再覆盖生效；生效配置可从启动日志（或 P1 就绪后的 `/admin/config`）观测。
4. **`/config`**：返回值与配置一致（含 TURN 段显隐）；客户端改为动态获取后联调通过，且 `/config` 不可用时客户端降级不崩。
5. **`/healthz`**：`{ok, rooms, uptime}` 字段与类型一致，`rooms` 随房间数实时变化。
6. **Docker**：amd64 + arm64 镜像 `buildx` 构建成功；`docker compose up` 一键起服务 + Redis；HEALTHCHECK 通过。
7. **优雅关闭**：SIGTERM 后 ≤ `shutdown_drain_secs` + 5s 退出；退出前存量连接收到关闭通知。
8. **静态托管**：MIME / SPA fallback / 路径穿越 403 / 404 与 TS 版行为一致。
9. **工程质量**：`cargo fmt`、`cargo clippy` 零警告，`cargo test` 通过；配置合并、协议编解码、房间状态机有单测。

**P1/P2 项：**

10. `/metrics` 暴露 §6.2 六类指标且数值合理。
11. 热重载：SIGHUP 或 `/admin/config` 修改日志级别/连接上限等生效**不重启**；`host`/`port` 变更被标记 `restart_required`。
12. 压测报告（P2/R18）：10 万连接保持 10 分钟，RSS ≤ 2GB，非主动断开率 ≈ 0；同节点 signal P99 ≤ 10ms；归档 `docs/m3-rust-signaling/benchmark.md`。
13. 多架构 CI（P2/R19）：push 触发 amd64/arm64 镜像构建。

---

## 8. 待确认问题（≤5）

| # | 问题 | 建议默认立场 |
|---|---|---|
| Q1 | TURN 凭证是否经 `GET /config` 明文下发浏览器？ | 功能上必要，但 credential 页面可见。建议默认下发 + 提供 `turn_credential_exposed` 开关，关闭时仅下发 STUN |
| Q2 | 管理 API 改配置是否写回 `config.toml`？ | 建议默认仅内存生效，重启以文件/环境变量为准，避免运行时文件写竞态 |
| Q3 | WS Origin 校验策略？同源部署下是否默认拒绝跨 Origin 升级？ | 建议默认宽松（保持 v1 行为），提供 `allowed_ws_origins` 配置按需收紧 |
| Q4 | 压测验收环境与硬件基线：本机 macOS/arm64 还是 Linux amd64？4C8G 还是 8C16G？ | 直接影响 10 万连接指标承诺，需在开工前锁定 |
| Q5 | Redis 高可用形态：单实例 / 主从 / Sentinel？`GOMOKU_REDIS_URL` 是否含认证？ | 建议 MVP 单实例 + 文档化主从方案，故障域承诺据此收窄 |

---

## 附：对下游的输入

- **架构师**：§3.4 模块划分/数据结构/性能策略为需求侧输入，具体设计与任务分解归你；§5 配置项为契约，增删需回签 PRD。
- **工程师**：§4 协议与 §5 配置为冻结契约；客户端改造范围 = `packages/web/src/webrtc.ts` 移除硬编码 `ICE_SERVERS`、改取 `/config`（含降级），其余协议代码零改动。
- **QA**：§7 DoD 为验收基线；协议兼容用例可直接复用 `test/` 与 vitest 现有客户端仿真。

---
