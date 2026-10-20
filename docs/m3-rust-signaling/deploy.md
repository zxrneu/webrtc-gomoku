# M3 v2.0 · Rust 信令服务器 · 部署与运维（Deploy）

| 项 | 内容 |
|---|---|
| 里程碑 | M3 · v2.0 |
| 落点 | `apps/signaling-rust/` |
| 关联 | PRD §3.1 R8 / §6.1；`architecture.md` §6.3 / §12-Q4、Q5、Q7、Q8 |
| 语言 | 中文 |

本文件覆盖**部署形态、探针、优雅关闭、Redis 形态、负载均衡与内核参数**。运行参数与配置键见
[`../../apps/signaling-rust/README.md`](../../apps/signaling-rust/README.md)。

---

## 1. 部署形态

### 1.1 单节点（无 Redis）

```bash
GOMOKU_REDIS_ENABLED=false GOMOKU_HOST=0.0.0.0 GOMOKU_PORT=3000 ./gomoku-signaling
```

显式关闭 Redis 时仅运行本节点，`gomoku_redis_connected=0`，不启动 Redis 重连任务。若启用了 Redis 但暂时不可达，本地房间/信令仍可用、跨节点能力暂停，后台任务按 1s→30s 指数退避重连。

### 1.2 多节点（Redis 中继）

```bash
GOMOKU_REDIS_URL=redis://redis.internal:6379 \
GOMOKU_NODE_ID=node-1 \
GOMOKU_PORT=3000 \
./gomoku-signaling
```

- `cluster.node_id` 必须**每个节点唯一**（默认 `<hostname>-<rand8>`，进程内稳定；容器场景建议显式指定）。
- 所有节点共用同一 `redis.channel_prefix`。

### 1.3 容器

`Dockerfile` 为多阶段构建，运行时基于 `debian:bookworm-slim`，**非 root**（uid `10001`），内置 `HEALTHCHECK`。多架构：

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t gomoku-signaling:2.0.0 .
```

`docker-compose.yml` 一键起「signaling + redis」，并把 `config.example.toml` 以只读方式挂到 `/app/config.toml`。

### 1.4 免 Docker：手动构建各平台二进制

不想装 Docker 时，可在目标机原生构建或本机交叉编译（Linux 可选 musl 静态链接，无 glibc 依赖），
部署 = 单个二进制 + `public/` 静态目录（web dist 内容）+ 可选 `config.toml`。
完整命令、平台 target 速查表与 systemd 示例见
[`../../apps/signaling-rust/README.md` §1.4](../../apps/signaling-rust/README.md)。

---

## 2. 探针

| 探针 | 端点 | 判据 |
|---|---|---|
| liveness | `GET /healthz` | HTTP 200 且 `ok:true` |
| readiness | `GET /healthz` | 同上（本服务无外部强依赖；Redis 不可用时仍应返回 200，跨节点能力自动降级） |
| 镜像健康检查 | 容器内 `curl -fsS http://127.0.0.1:${GOMOKU_PORT}/healthz` | 见 `Dockerfile` 的 `HEALTHCHECK` |

Kubernetes 建议：

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
  initialDelaySeconds: 5
  periodSeconds: 15
readinessProbe:
  httpGet: { path: /healthz, port: 3000 }
  periodSeconds: 10
```

> `/healthz` 返回 `{ok, rooms, uptime}`，字段与 v1 一致；`rooms` 实时取 `RoomTable::len()`。**不要**用 `/metrics` 做探针（其文本量随指标基数增长）。

`/healthz` 只验证 HTTP 存活，不能代替大厅业务探测。部署与压测应另外检查 `/signal` 上的列表查询、邀请入座及恢复；测试命令见[大厅说明](../m6-lobby/README.md#测试)。

---

## 3. 优雅关闭

**流程**（PRD §3.1 R10 / architecture §4.4）：

1. 收到 `SIGTERM` / `SIGINT` → 触发 shutdown。
2. 停止接受新连接（`with_graceful_shutdown`；排空期 `/signal` 返回 503）。
3. 向存量连接广播关闭（WS `Close(1001)`）。
4. 等待连接关闭 ≤ `timeouts.shutdown_drain_secs`（默认 **15s**）。
5. 超时则强制关闭剩余连接；随后最多再等 5s 退出。

**编排建议**：给容器 `terminationGracePeriodSeconds` 预留 ≥ `shutdown_drain_secs + 5s`（默认 ≥ 20s），避免 SIGKILL 截断排空。

```yaml
terminationGracePeriodSeconds: 25
```

> **不要**用 `SIGKILL` 直接终止；请用 `SIGTERM`（`docker stop` 默认即是）。

---

## 4. 信号与热重载

| 信号 | 行为 |
|---|---|
| `SIGTERM` / `SIGINT` | 优雅关闭（见 §3） |
| `SIGHUP` | 热重载：重读 `config.toml` + 环境变量 → 校验 → 差异应用 |

- **即时生效**：`logging.level`、`limits.*`、`cors.origins`、`ice.*`、`admin.token`。
- **需重启**：`server.host`、`server.port`、`server.public_dir`、`redis.url`（`POST /admin/config` 会在 `restart_required` 中列出）。
- 非法配置**拒绝应用**并保留旧快照，进程不崩溃。

容器中触发 SIGHUP：

```bash
docker kill --signal=HUP <container>
```

---

## 5. Redis 形态（架构 §12-Q5 / Q8）

**MVP 采用单实例 Redis**（含 Sentinel 亦可，客户端仅需一个可用地址）。理由：

- 房间注册只需 `SET NX EX`、`SCARD`、`SREM`、`SADD`、`EXPIRE`、`DEL` —— 全部为**单键 / 少量键**操作。
- 跨节点广播用 **pub/sub**（非持久化，允许丢消息：信令可重传/重协商）。

> ⚠️ **Redis Cluster 限制**：pub/sub 在 Cluster 模式下**不会跨分片广播**，且 Lua 脚本要求 `KEYS` 落在**同一 slot**。当前 key 布局（`{prefix}:room:{CODE}` 与 `{prefix}:room:{CODE}:members`）**未使用 hash tag**，因此**不建议**直接指向 Redis Cluster。如需 Cluster，请为 key 增加 `{CODE}` 形式的 hash tag 并改用 `SSUBSCRIBE`/`SPUBLISH`（属后续增强，非本期范围）。

**容量与 TTL**：

- 房间注册键带 `redis.room_ttl_secs`（默认 3600s）TTL；成员集合随房间删除而清理。
- `redis.pool_size`（默认 16）为**发布**连接池；订阅另用**一条**专用连接（`SUBSCRIBE` 会独占连接）。

**持久化**：pub/sub 与房间注册均为**易失**数据，建议 `--save "" --appendonly no`（compose 已如此配置），无需持久化。

**监控**：`gomoku_redis_connected`（0/1）反映订阅任务连通性；断线期自动退避重连。

---

## 6. 负载均衡与客户端 IP（架构 §12-Q7，**重要**）

### 6.1 无需 sticky session

房间的**全局唯一性**与**跨节点容量**由 Redis 保证，信令经 pub/sub 转发，因此 LB 可**轮询**分发，**无需**会话保持（sticky session）。

### 6.2 per-IP 限流的 IP 来源

`limits.max_connections_per_ip`（默认 10）的判定 IP：

- **默认**：socket 对端地址（`ConnectInfo<SocketAddr>`），**不信任任何请求头**。
- **仅当** `server.trust_proxy_headers = true`：取 `X-Forwarded-For` **最左**地址。

> `X-Forwarded-For` 可被客户端伪造，默认信任会**击穿** per-IP 限流，故**默认关闭**。

**前置 LB 场景必须显式打开 `trust_proxy_headers = true`**，否则：

- LB 之后的**所有连接**会以 LB 的内网 IP 计入，10 条连接即触发 per-IP 限流（`503 Too many connections`）；
- 且无法区分真实客户端。

**前提条件**：LB / 入口网关必须**覆盖写入**（而非追加）`X-Forwarded-For`，并剥离客户端自带的同名头；否则仍可被伪造。

```toml
[server]
trust_proxy_headers = true
```

---

## 7. 内核参数与系统调优（基准：Linux amd64 / 4C8G，架构 §12-Q4）

WS 为**长连接**，主要瓶颈是**文件描述符**与**内存**，而非端口耗尽。建议：

```bash
# /etc/security/limits.conf 或 systemd LimitNOFILE
*    soft    nofile    1048576
*    hard    nofile    1048576

# 连接队列（若 QPS 抖动导致握手失败）
net.core.somaxconn = 32768
net.ipv4.tcp_max_syn_backlog = 32768

# TIME_WAIT 复用（短连接较多时）
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 10000 65535

# 每个 socket 的读写缓冲（按需，长连接场景可略增）
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
```

容器/进程层面：

- `limits.max_connections` 默认 100000，这是通用信令配额与设计目标，尚未通过对应规模压测。大厅另有 2000 会话及 1000 房间的准入边界；按实际出口带宽和业务负载验收，不用连接配置推定承载量。压力测试命令见[大厅说明](../m6-lobby/README.md#测试)。
- 若采用 `jemalloc` 特性（`--features jemalloc`），可降低长时间运行下的内存碎片。

---

## 8. 上线检查清单

- [ ] `cluster.node_id` 每节点唯一（容器中显式指定）。
- [ ] `GOMOKU_REDIS_URL` 指向可达 Redis；`redis.channel_prefix` 各节点一致。
- [ ] 前置 LB 场景：**已置 `server.trust_proxy_headers = true`**，且 LB 覆盖写 `X-Forwarded-For`。
- [ ] `admin.token` 已设置（否则管理面为 404 关闭；如需运维接口则配置强随机 Token）。
- [ ] `ice.turn_url` / `turn_username` / `turn_credential` 已配置；如不希望明文下发凭据，置 `turn_credential_exposed = false`。
- [ ] 静态目录（`packages/web/dist`）已随镜像/挂载就位。
- [ ] 探针指向 `/healthz`；`terminationGracePeriodSeconds ≥ shutdown_drain_secs + 5`。
- [ ] 抓取 `/metrics`（`gomoku_*`），并告警 `gomoku_redis_connected == 0`。
- [ ] 文件描述符上限已提升（见 §7）。
