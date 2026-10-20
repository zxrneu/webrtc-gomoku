# 服务大厅

服务大厅位于 `/lobby`，提供在线棋友、昵称搜索、定向邀请、快速匹配与公开房间。入座后进入棋盘，落子、聊天和富媒体通过 WebRTC P2P 传输。功能与交互要求见[产品需求](prd.md)。

## 运行

在仓库根目录执行：

```sh
pnpm build
pnpm start
```

访问 `http://localhost:3000/lobby`。开发时分别启动 `pnpm dev:server` 与 `pnpm dev`；Rust 启动方式见 [Rust 服务说明](../../apps/signaling-rust/README.md)。

在线页面位于 `packages/web/dist/index.html`；离线单文件 `dist/gomoku-standalone.html` 不包含大厅。语音消息需要受信任的 HTTPS，见 [HTTPS 配置](../https.md)。

## 运行边界

- Node 和 Rust 均支持大厅。在线名册、邀请、匹配队列保存在单个节点内存中，重启后清空；Rust 的 Redis 跨节点房间信令不提供全局大厅名册或撮合。
- Rust 使用定向即时通知与每秒合并发布：公共状态无变化时不广播，列表查询单独响应；邀请、匹配与房内通知即时发送。Node 未同步这一合并发布机制。
- 浏览器每 5 秒查询列表；HTTP 按需分页、增量通知和后台暂停刷新属于[后续规划](../../ROADMAP.md#m6--服务大厅后续迭代)。
- 每节点最多 2000 个大厅会话，达到 1000 个房间时拒绝新的大厅准入。配额不代表生产容量，持续状态变化可能触发完整列表广播，须按实际带宽和业务负载验收。
- 当前窗口的身份、座位凭证与棋谱保存在 sessionStorage，服务端校验后可在宽限期内恢复；存储不可用时不保证刷新恢复。凭证不放入 URL、名册或日志。

## 测试

先启动独立测试实例，将 `BASE` 设为该实例地址。Node 默认本地地址为 `http://127.0.0.1:3000`；Rust 地址按启动配置设置。

```sh
# 完整浏览器回归；要求真实 P2P 连接
BASE=http://127.0.0.1:3000 REQUIRE_P2P=1 pnpm test:e2e

# 协议边界与窗口隔离；LONG_TESTS 包含真实 30/60 秒超时
BASE=http://127.0.0.1:3000 LONG_TESTS=1 node test/lobby-protocol.e2e.js
BASE=http://127.0.0.1:3000 node test/lobby-edge.e2e.js

# 连接配额：Node 默认为 10，Rust 按 max_connections_per_ip 配置填写
BASE=http://127.0.0.1:3000 IP_LIMIT=10 node test/lobby-limits.e2e.js
```

共用匹配队列的测试必须串行运行，避免测试会话相互配对。`/healthz` 只表示 HTTP 存活，验收还需覆盖列表查询、邀请入座、真实落子和断线恢复。

压力测试会大量建房和断线，仅在隔离实例运行；先按测试规模调整实例的全局与单 IP 连接配额。

```sh
BASE=http://127.0.0.1:3000 SIZES=2000 PUBLIC_ROOMS=100 HOLD_MS=15000 \
  OUT=output/lobby-stress.json node test/lobby-stress.js

# 可在另一终端运行查询探针
BASE=http://127.0.0.1:3000 DURATION_MS=75000 \
  OUT=output/lobby-probe.json node test/lobby-probe.js
```

记录持续状态变化、断线波与慢消费者下的查询延迟、出口带宽、CPU / 内存及连接回收；短时本地结果不能代替生产稳定性验收。
