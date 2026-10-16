# gomoku-signaling (Rust)

WebRTC 五子棋的**信令服务器 + 静态托管**（M3 v2.0，Rust 重写版）。

服务器只做两件事：

1. 托管单页客户端（静态文件）。
2. 按房间转发 WebRTC 信令（offer / answer / ice）。**对局数据永不经过服务器**，只走 P2P DataChannel。

> 协议（WS 消息集合 / 字段名 / 错误文案）与 `packages/shared/src/types.ts` **逐字节冻结对齐**，不得新增或修改。

---

## 1. 快速开始

### 1.1 本地运行

```bash
cd apps/signaling-rust

# 可选：自定义配置（不创建则全部使用内置默认值）
cp config.example.toml config.toml

cargo run --release
# 日志：信令服务器已启动 addr=0.0.0.0:3000
```

静态目录按 `[配置值, packages/web/dist, dist, public]` 顺序**回退探测**第一个存在的目录；前端产物请放到 `packages/web/dist`（或构建后复制到 `public/`）。

### 1.2 Docker Compose 一键起（服务 + Redis）

```bash
cd apps/signaling-rust
docker compose up --build
# 浏览器打开 http://localhost:3000
```

镜像在构建阶段用 pnpm 构建 `packages/web` 并把产物打进 `/app/public`（回退探测链命中 `public` 候选），因此**无需挂载前端产物**，`:3000` 开箱即用。

### 1.3 多架构镜像

```bash
# 在仓库根目录执行（build context = 仓库根，含前端构建阶段）
docker buildx build --platform linux/amd64,linux/arm64 -t gomoku-signaling .
```

镜像以非 root（uid `10001`）运行，`HEALTHCHECK` 走 `/healthz`。Rust 依赖按 `Cargo.lock` 锁定（`cargo build --release --locked`），前端依赖按 `pnpm-lock.yaml` 锁定（`pnpm install --frozen-lockfile`），构建可复现。

### 1.4 手动构建各平台二进制（免 Docker）

适用于轻量服务器（如 Lighthouse）不装 Docker、或要分发单一可执行文件的场景。
依赖全部为纯 Rust（无 OpenSSL 等 C 依赖），Linux 下可**静态链接**，拷到同架构任何发行版都能跑。

**方式 A · 目标机原生构建（最稳，零交叉编译陷阱）**

```bash
# 在目标机器上（ rustup 安装 stable 即可，版本以 rust-toolchain.toml 为准）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
# 把仓库放到目标机后：
cd apps/signaling-rust
cargo build --release --locked
# 产物：target/release/gomoku-signaling
```

**方式 B · 本机交叉编译（一条命令出包）**

```bash
# 路线 1：cross（底层用 Docker 隔离目标 sysroot，最省心）
cargo install cross
cross build --release --target x86_64-unknown-linux-gnu
cross build --release --target aarch64-unknown-linux-gnu

# 路线 2：cargo-zigbuild（借 zig 的 cc，免 Docker）
cargo install cargo-zigbuild
cargo zigbuild --release --target x86_64-unknown-linux-musl

# 路线 3：rustup 直装 musl target 后原生静态构建（仅 Linux 宿主可行，无第三方工具）
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
cargo build --release --locked --target x86_64-unknown-linux-musl
# 产物：target/x86_64-unknown-linux-musl/release/gomoku-signaling（无 glibc 依赖）
# ⚠️ macOS / Windows 宿主直连 musl 会在链接期失败（系统 ld 不识别 GNU 静态链接参数，
#    实测报错 ld: unknown options: --as-needed -Bstatic ...）。此时请用上面的
#    cargo-zigbuild 或 cross 路线——它们提供 lld + musl sysroot。
```

**平台速查表**

| 目标平台 | target triple | 备注 |
|---|---|---|
| Linux x86_64（主流云服务器） | `x86_64-unknown-linux-gnu` | 或 musl 静态版 |
| Linux arm64（鲲鹏 / Ampere / Apple Silicon 虚机） | `aarch64-unknown-linux-gnu` | 或 musl 静态版 |
| Linux 静态通用（老发行版 / Alpine） | `x86_64-unknown-linux-musl` | **推荐**：无 glibc 依赖 |
| macOS Apple Silicon | `aarch64-apple-darwin` | M 系列 Mac 原生 |
| macOS Intel | `x86_64-apple-darwin` | |
| Windows | `x86_64-pc-windows-msvc` | 产物为 `.exe`，功能一致 |

**部署：二进制 + `public/` 两步走**（二进制**不含**前端页面，静态目录按回退链探测）

```bash
# 1. 在有 Node 的机器上构建前端产物（或在目标机装好 Node 后执行）
pnpm --filter @webrtc-gomoku/web build        # 产物在 packages/web/dist

# 2. 组装部署目录（二进制 + public/ + 可选 config.toml）
mkdir -p /opt/gomoku
cp target/release/gomoku-signaling /opt/gomoku/
cp -r packages/web/dist/* /opt/gomoku/public/     # 或用 GOMOKU_PUBLIC_DIR 指向绝对路径

# 3. 启动与验收
GOMOKU_REDIS_ENABLED=false /opt/gomoku/gomoku-signaling &
curl -s localhost:3000/healthz                # 期望 {"ok":true,...}
```

> 放行防火墙入站 TCP `3000`；HTTPS 生产环境按根 README 的 Nginx 反代方案前置。
> `redis.enabled=false` 表示单节点有意关闭（非故障），见 §1.5。
> systemd 守护示例：`ExecStart=/opt/gomoku/gomoku-signaling` + `Environment=GOMOKU_REDIS_ENABLED=false` + `Restart=on-failure`，`KillSignal=SIGTERM` 以走优雅关闭（§5.1）。

### 1.5 单节点部署：**不需要 Redis**

**Redis 是可选的。** 它只服务于**跨节点**能力——同房间两人落在不同节点时的信令中转、房间号全局唯一（`SET NX EX`）、跨节点 1v1 容量判定。单节点部署下本地 `RoomTable` 已能完成全部功能，**不要起 Redis**：

```toml
[redis]
enabled = false
```

等价写法：环境变量 `GOMOKU_REDIS_ENABLED=false`，或 `GOMOKU_REDIS_URL=""`（空 url 等同禁用）。

| | `enabled = true`（默认）但 Redis 不可达 | `enabled = false` |
|---|---|---|
| 本地建房 / 加入 / 信令 | ✅ 可用 | ✅ 可用 |
| 跨节点牵手 | ❌ 不可用 | ❌ 不可用 |
| 后台重连任务 | 常驻，1s→30s 指数退避 | **完全不启动** |
| 日志 | 每 30s 一条 `warn`，永不停 | 启动时一条 `info`，之后静默 |
| `gomoku_redis_connected` | `0`（含义＝**故障**） | `0`（含义＝**按配置关闭**，非故障） |

> 两者**功能等价**，差别只在语义：`enabled = false` 是「有意关闭」，Redis 不可达是「故障降级」。
> 单节点生产环境请用前者——否则 `gomoku_redis_connected=0` 会持续触发误告警。
> `redis.enabled` 与 `redis.url` 的变更**需重启生效**（热重载会返回 `restart_required`）。

---

## 2. 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 存活探针：`{ok:true, rooms, uptime}`（字段/类型与 v1 一致） |
| `GET` | `/config` | 下发 `{iceServers:[...]}`（`Cache-Control: no-cache`） |
| `GET` | `/metrics` | Prometheus 文本指标（`gomoku_*`） |
| `GET` | `/signal` | WebSocket 升级入口（信令） |
| `GET/POST` | `/admin/config` | 管理面：读脱敏配置 / 应用内存态补丁（需 Bearer Token） |
| `GET` | `/*` | 静态托管（SPA fallback / 403 / 404） |

### 2.1 `/config` 的 TURN 显隐（架构 §12-Q1）

`iceServers` 始终包含 STUN 段。TURN 段**仅当** `ice.turn_url` 非空 **且** `ice.turn_credential_exposed = true`（默认 `true`）时才明文下发。生产环境若不希望明文暴露 TURN 凭据，置 `turn_credential_exposed = false`（此时仅下发 STUN）。

### 2.2 `/admin/config`（架构 §12-Q2）

- `admin.token` 为空 ⇒ 整个 `/admin/*` 返回 **404**（关闭管理面）。
- Token 错误 ⇒ **401**；正确 ⇒ **200**。
- `GET` 返回**脱敏**配置（`turn_credential` / `admin.token` / `redis.url` 内嵌密码 = `***`）。
- `POST` 接受部分配置补丁，返回 `{applied, restart_required}`；**只作用于内存，不写回 `config.toml`**。非法补丁 ⇒ **400**，保留旧配置。

---

## 3. 配置

### 3.1 三层合并（后者覆盖前者）

```
内置默认值  <  config.toml  <  环境变量（GOMOKU_*）
```

- 配置文件路径：`GOMOKU_CONFIG_FILE`（默认 `./config.toml`）。
- 环境变量数组用**逗号分隔**（如 `GOMOKU_CORS_ORIGINS=https://a,https://b`）。
- 加载即**校验**（fail-fast）：端口越界、超时为 0、URL 非法等 ⇒ 进程启动失败并打印 `配置项 {key} 非法: {reason}`。

### 3.2 全量键 ↔ 环境变量 ↔ 默认值

`config.example.toml`（无注释版）与 `config.example`（带注释版）为 PRD §5.2 全量示例，取值即内置默认值。

| 配置键 | 环境变量 | 默认值 |
|---|---|---|
| `server.host` | `GOMOKU_HOST` | `0.0.0.0` |
| `server.port` | `GOMOKU_PORT` | `3000` |
| `server.public_dir` | `GOMOKU_PUBLIC_DIR` | `public` |
| `server.allowed_ws_origins` | `GOMOKU_ALLOWED_WS_ORIGINS` | `[]`（空 = 不校验 Origin） |
| `server.trust_proxy_headers` | `GOMOKU_TRUST_PROXY_HEADERS` | `false` |
| `timeouts.ws_ping_interval_secs` | `GOMOKU_WS_PING_INTERVAL` | `30` |
| `timeouts.ws_idle_timeout_secs` | `GOMOKU_WS_IDLE_TIMEOUT` | `60` |
| `timeouts.ws_handshake_timeout_secs` | `GOMOKU_WS_HANDSHAKE_TIMEOUT` | `10` |
| `timeouts.shutdown_drain_secs` | `GOMOKU_SHUTDOWN_DRAIN` | `15` |
| `limits.max_connections` | `GOMOKU_MAX_CONNECTIONS` | `100000` |
| `limits.max_connections_per_ip` | `GOMOKU_MAX_CONNECTIONS_PER_IP` | `10` |
| `limits.max_rooms` | `GOMOKU_MAX_ROOMS` | `50000` |
| `limits.max_message_bytes` | `GOMOKU_MAX_MESSAGE_BYTES` | `65536` |
| `limits.broadcast_queue_capacity` | `GOMOKU_BROADCAST_QUEUE_CAPACITY` | `256` |
| `redis.url` | `GOMOKU_REDIS_URL` | `redis://127.0.0.1:6379` |
| `redis.pool_size` | `GOMOKU_REDIS_POOL_SIZE` | `16` |
| `redis.channel_prefix` | `GOMOKU_REDIS_CHANNEL_PREFIX` | `gomoku:signal` |
| `redis.connect_timeout_ms` | `GOMOKU_REDIS_CONNECT_TIMEOUT_MS` | `5000` |
| `redis.room_ttl_secs` | `GOMOKU_ROOM_TTL` | `3600` |
| `cluster.node_id` | `GOMOKU_NODE_ID` | `<hostname>-<rand8>`（进程内稳定） |
| `cluster.nodes` | `GOMOKU_CLUSTER_NODES` | `[]` |
| `cors.origins` | `GOMOKU_CORS_ORIGINS` | `[]`（空 = 不加 CORS 头） |
| `logging.level` | `GOMOKU_LOG_LEVEL` | `info` |
| `logging.format` | `GOMOKU_LOG_FORMAT` | `text` |
| `ice.stun_servers` | `GOMOKU_STUN_SERVERS` | 4 个公共 STUN（见 `config.example.toml`） |
| `ice.turn_url` | `GOMOKU_TURN_URL` | `""`（空 = 不下发 TURN 段） |
| `ice.turn_username` | `GOMOKU_TURN_USER` | `""` |
| `ice.turn_credential` | `GOMOKU_TURN_CREDENTIAL` | `""` |
| `ice.turn_credential_exposed` | `GOMOKU_TURN_CREDENTIAL_EXPOSED` | `true` |
| `admin.token` | `GOMOKU_ADMIN_TOKEN` | `""`（空 = 关闭管理面） |

> **新增键**（相对 PRD §5.2 首版）：`limits.broadcast_queue_capacity`、`ice.turn_credential_exposed`、`server.allowed_ws_origins`、`server.trust_proxy_headers`。均已在 `config.example.toml`、`config.example`、环境变量映射与 `/admin/config` 脱敏视图中登记。

### 3.3 per-IP 限流的客户端 IP 来源（架构 §12-Q7）

**默认取 socket 对端地址**（`ConnectInfo<SocketAddr>`），**不信任任何请求头**。

仅当服务明确部署在**可信反向代理 / 负载均衡之后**、且已剥离外部伪造头时，才置 `server.trust_proxy_headers = true`，此时取 `X-Forwarded-For` 的**最左**地址。

> 该头可被客户端伪造，默认信任会**击穿** per-IP 限流，故默认关闭。**前置 LB 场景必须显式打开**，否则所有连接会被计为同一个 LB 内网 IP，10 条连接即触发限流。

---

## 4. 负载均衡：**无需 sticky session**

房间状态（`RoomTable`）是**节点本地**的，但房间的**全局唯一性**与**跨节点容量**由 Redis 保证：

- `create` / `join` / `leave` 走 Redis Lua 脚本（`SET NX EX` / `SCARD` / `SREM`）。
- 跨节点信令通过每房间 pub/sub 频道转发。
- 房间 TTL 由**后台周期刷新**（周期 = `room_ttl_secs / 3`，遍历本地房间表对双键 EXPIRE）维持——信令热路径零额外 Redis RTT；本地准入失败时自动幂等回滚 Redis 成员（SREM），杜绝陈旧占位。
- 因此任意节点都可由 LB **轮询**分发，**不需要**会话保持（sticky session）。

Redis 不可用时**优雅降级**为仅本节点（`gomoku_redis_connected=0`），进程不崩溃；恢复后订阅任务按 1s→30s 指数退避自动重连。

> **不需要跨节点时请直接关闭**：`redis.enabled = false`（详见 §1.5）。单节点部署下跨节点能力用不上，关掉可省去常驻重连任务与每 30s 一条的 `warn` 日志，同时让 `gomoku_redis_connected=0` 不再被误读为故障。

---

## 5. 运维

### 5.1 信号

| 信号 | 行为 |
|---|---|
| `SIGTERM` / `SIGINT` | 优雅关闭：停止 accept → 广播关闭 → 排空 ≤ `shutdown_drain_secs` → 超时强制退出 |
| `SIGHUP` | 热重载：重读 `config.toml` + 环境变量 → 校验 → 差异应用 |

### 5.2 热重载边界（PRD §5.3，F3 后）

- **即时生效**：`logging.level`（动态日志级别）、`limits.max_connections`、`limits.max_connections_per_ip`、`limits.max_rooms`、`limits.broadcast_queue_capacity`、`redis.room_ttl_secs`、`server.allowed_ws_origins`、`server.trust_proxy_headers`、`timeouts.ws_ping_interval_secs`、`timeouts.ws_idle_timeout_secs`、`ice.*`、`admin.token` 等（只影响新连接或全局可变状态的键）。
- **需重启**：`server.host`、`server.port`、`server.public_dir`、`redis.enabled`、`redis.url`、`redis.pool_size`、`redis.channel_prefix`、`redis.connect_timeout_ms`、`cors.origins`、`logging.format`、`limits.max_message_bytes`、`timeouts.ws_handshake_timeout_secs`、`timeouts.shutdown_drain_secs`、`cluster.node_id`（均在 `POST /admin/config` 的 `restart_required` 中如实返回）。
  - 原因：这些键的处理器在**启动时固化**——CORS 与 HTTP body limit 是路由组装时构建的中间件层，Redis 连接池 / channel 前缀 / 连接超时在后台连接器成功时安装，node id 烘进 `AppState`，日志格式在 tracing subscriber 初始化时选定。
- 非法配置被**拒绝**并保留旧快照，进程不崩溃。

### 5.3 指标（Prometheus，`gomoku_` 前缀）

| 指标 | 类型 | 含义 |
|---|---|---|
| `gomoku_ws_connections` | gauge | 当前 WS 连接数 |
| `gomoku_rooms` | gauge | 当前房间数 |
| `gomoku_messages_total{type}` | counter | 按消息类型计数（create/join/signal/leave） |
| `gomoku_errors_total{kind}` | counter | 按错误类型计数 |
| `gomoku_signal_latency_seconds` | histogram | 信令转发延迟分布 |
| `gomoku_redis_connected` | gauge | Redis 连通状态 0/1 |

---

## 6. Rust 版与 Node fallback 的切换

信令服务有 Rust 版与 Node 版两份实现，二者**协议完全一致**，可互为替换：Rust 版推荐用于生产，Node 版 `apps/server` 作为 fallback / 协议参考实现。

```bash
# Rust 版（推荐，生产）
cd apps/signaling-rust && cargo run --release

# Node 版（fallback；须在仓库根目录执行，前端静态资源由它托管）
cd ../.. && pnpm build && node apps/server/dist/server.js
```

前端无需任何改动即可连任一后端；切换后端不影响既有对局。

---

## 7. 开发与质量红线

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

- **热路径红线**：无 `unwrap` / `expect`、无 `info!`/`println!`、无磁盘 IO、无 `unbounded_channel`。
- **依赖方向**（严格无环）：`protocol ◄ rooms ◄ transport ◄ http ◄ main`；`config` / `metrics` 为叶子；`relay` 经 `rooms::LocalDelivery` trait 回投（依赖反转）。
- **测试**：`src/<module>` 单测 + `tests/*.rs` 跨模块集成测试（真实 loopback TCP + WS，无外部依赖；跨节点用 `FakeCluster` 仿真）。
- **错误文案**：5 条错误文案集中在 `protocol::messages`，禁止散落字符串。
