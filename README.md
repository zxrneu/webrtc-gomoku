# WebRTC P2P 五子棋

浏览器之间通过 **WebRTC DataChannel 直连对战**的联机五子棋。**零服务器**：单文件 HTML 通过微信互发，双方互发连接码即建立 P2P 直连，落子、聊天等对局数据全部在两端之间传输。

> 第一原则不变：单文件微信互发永远可用。可选的「房间联机」（自动牵线）现在由 **M3 v2.0 Rust 信令服务器**承载（`apps/signaling-rust`），不需要时一行部署都不用做。

## 当前支持（v2.0）

- **同一局域网直连**：同一 WiFi/内网下 IPv4 host 候选直连，无需任何服务器
- **可达 IPv6 直连**：双方全球单播 IPv6（`2408:`/`2409:` 等）端到端可达，
  host 候选直连——**无 NAT、无需 STUN**，这是 IPv6 对 P2P 的红利
- **微信互发邀请**：单文件 HTML（约 228KB 零运行时依赖）+ 连接码互发，交互式引导流程
- **扫码配对**：双向二维码 + BarcodeDetector/jsQR 双模识别 + 相册兜底
- **对局功能**：15×15 棋盘、回合制、悔棋（需对方同意）、重新开始、最后一手标记、
  胜利连线高亮、对局聊天、掉线提示、音效开关、移动端自适应
- **连接透明度**：连接成功后显示实际传输方式（IPv6 直连 / IPv4 直连 /
  NAT 穿透 / TURN 中继）；连不上时给出原因诊断
- **STUN/TURN 动态下发（v2.0 新增）**：部署信令服务器后，ICE 服务器列表改由
  `GET /config` 下发（`packages/web/src/iceConfig.ts`），失败自动降级到内置同款列表

## 里程碑

详细路线图见 **[ROADMAP.md](ROADMAP.md)**，当前进度：

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| **M1 · v1.2** | 扫码配对（双向二维码）/ 文件传输 / 语音 / 视频，零服务器 | [x] 扫码已完成 |
| **M2 · v1.3** | 全量 TypeScript + pnpm workspace + React 19 + CSS Modules + 单文件打包 | [x] 已完成 |
| **M3 · v2.0** | 信令服务器 Rust 重写（tokio + axum + Redis，10 万+ 长连接）+ STUN/TURN 动态下发 | [x] 已交付（`4e13b98`；10 万连接压测报告与多架构 CI 为计划内后置） |
| **M4 · v3.0** | App 打包（PWA → Tauri/Capacitor）、微信小程序/小游戏、广告变现 | 规划中 |

> 公网 IPv4 NAT 穿透（双方在不同家庭宽带后）：代码已内置腾讯/阿里公共 STUN 尽力尝试，
> 成功率取决于 NAT 类型，**不在当前版本的支持承诺范围内**。

## Monorepo 工程架构（pnpm workspace）

项目已全面迁移为 TypeScript Monorepo，模块边界清晰且支持现代 React 与独立单文件打包：

```
webrtc-gomoku/
├── packages/
│   ├── core/         # @webrtc-gomoku/core: 纯 TypeScript 五子棋引擎（规则、状态、胜负与悔棋算法）
│   ├── shared/       # @webrtc-gomoku/shared: 共享信令与对局协议、deflate-raw + base64url 压缩编解码
│   └── web/          # @webrtc-gomoku/web: React 19 + CSS Modules + Canvas 15×15 棋盘 + Vite 单文件打包
├── apps/
│   └── server/       # @webrtc-gomoku/server: TypeScript HTTP 静态托管与 WebSocket 信令中继服务
├── dist/
│   └── gomoku-standalone.html # 构建产物：全内联单文件 HTML（零服务器依赖，可直接微信互发或离线运行）
├── test/
│   ├── qr-scan.test.js # Playwright 自动化二维码生成、折叠与扫描测试
│   └── e2e.js          # Playwright 双端端到端对局与信令链路全流程测试
└── package.json
```

## 单文件版（微信互发 · 零服务器）

不想部署服务器？构建单文件 HTML（全部代码内联、无外部依赖），
通过微信文件互发给对方，双方双击打开，用「手动信令」模式扫码或互发连接码即可 P2P 对战：

```bash
pnpm install
pnpm run build    # 构建所有包并生成 dist/gomoku-standalone.html
```

对局步骤（双方都打开单文件后，切到「手动信令」标签）：

1. **邀请方**点「创建房间」→ 邀请码自动生成（附带二维码）→ 微信发给对方或面对面扫码
2. **对方**点「加入房间」→ 扫码/粘贴邀请码 →「生成应答码」→ 微信发回或展示二维码
3. **邀请方**扫码/粘贴应答码 → 点「完成连接」→ 开始下棋

网络说明：**同一局域网或双方可达 IPv6 时自动直连**；
连不上时面板会给出原因诊断。也可从 GitHub Release 直接下载现成单文件。

## 本地开发与测试

```bash
# 启动前端开发服务器 (Vite)
pnpm dev

# 启动信令服务器 (开发模式，Node 版)
pnpm dev:server

# 或启动 Rust 版信令服务器 (M3，apps/signaling-rust)
cargo run --manifest-path apps/signaling-rust/Cargo.toml

# 构建全部包 (Core, Shared, Web, Server) 并导出独立 HTML
pnpm run build

# 运行五子棋引擎与 Codec 单元测试 (Vitest)
pnpm test

# 运行 legacy 单文件版引擎测试 (public/game-core.js)
pnpm test:legacy

# 运行二维码生成与摄像头/图片扫描自动化测试 (Playwright)
pnpm test:qr

# 运行信令与 P2P 对局端到端测试 (Playwright，默认指向 Node 版)
PORT=3000 node apps/server/dist/server.js &
pnpm test:e2e
# 也可指向 Rust 版信令服务器（协议完全兼容，客户端零改动）：
BASE=http://127.0.0.1:3000 node test/e2e.js
```

- 本机测试：开两个浏览器标签访问 `http://localhost:3000`，一个创建房间、一个加入
- 手机/其他设备：访问启动日志里打印的局域网地址，如 `http://<你的局域网IP>:3000`
- 单元测试：`pnpm test`（Vitest，33 项全部通过：五子棋规则 10 · Codec 编解码 4 · ICE 配置 19）；legacy 单文件引擎另跑 `pnpm test:legacy`（11 项）
- E2E 测试：`pnpm test:e2e`（Playwright 双浏览器模拟对打，全流程覆盖信令链路、落子同步、胜负、聊天、悔棋、重开、手动邀请对局与断线诊断）

## 架构

```
当前版本（v1.1 · 零服务器）：

  玩家A 浏览器  <—— DataChannel(P2P 直连) ——>  玩家B 浏览器
      连接码（邀请/应答）经微信等任意聊天工具互发

房间联机（可选，需部署信令服务器——Node `apps/server`（协议参考实现/fallback）或 M3 Rust 版 `apps/signaling-rust`，推荐）：

  玩家A 浏览器  <—— DataChannel(P2P) ——>  玩家B 浏览器
      \                                      /
       \  WebSocket 信令(offer/answer/ice)  /
        \                                  /
             信令服务器 (ws /signal)
          （仅牵线；对局数据不经过它）
```

## 里程碑：部署信令服务器到腾讯云轻量应用服务器（Lighthouse）

> 仅当你要启用「房间联机」（自动牵线）时才需要部署；单文件微信互发模式不需要任何服务器。

**方式一：Node 直接运行（最快）**

```bash
# 1. 安装 Node.js 18+ 与 pnpm（Debian/Ubuntu 镜像）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
corepack enable && corepack prepare pnpm@latest --activate

# 2. 上传代码到服务器（如 /opt/webrtc-gomoku），安装依赖并构建
cd /opt/webrtc-gomoku
pnpm install --frozen-lockfile && pnpm build

# 3. 启动（任选其一；必须在仓库根目录执行，否则静态资源回退探测找不到 packages/web/dist）
PORT=3000 node apps/server/dist/server.js                   # 前台
nohup node apps/server/dist/server.js > gomoku.log 2>&1 &   # 后台
pm2 start apps/server/dist/server.js --name gomoku          # pm2 守护（推荐）
```

4. **放行端口**：轻量控制台 → 实例 → 防火墙 → 添加规则，放行 TCP `3000`（入站）
5. 访问 `http://<服务器公网IP>:3000`

**方式二：Docker（Rust 镜像，一键起信令服务 + Redis，镜像内含前端静态资源）**

```bash
cd apps/signaling-rust
docker compose up --build
```

**方式三：Rust 信令服务器原生运行（M3 v2.0，推荐用于房间联机）**

tokio + axum + Redis，单机 10 万+ 长连接设计；WS 协议与 Node 版逐字兼容，客户端零改动：

```bash
cd apps/signaling-rust
cp config.example.toml config.toml
cargo run --release            # 前台运行；容器化部署见上文方式二
```

- `GOMOKU_REDIS_ENABLED=false` 可单节点运行（不装 Redis）；跨节点牵手才需要 Redis
- 三层配置（默认值 < `config.toml` < 环境变量）+ SIGHUP/`/admin/config` 热重载
- 免 Docker：可手动构建各平台二进制（含 Linux musl 静态版，单文件即部署），见 `apps/signaling-rust/README.md` §1.4
- `/healthz`、`/metrics`、`/config`（STUN/TURN 动态下发）
- 完整部署/运维文档：`apps/signaling-rust/README.md`、`docs/m3-rust-signaling/deploy.md`

**生产建议**：用 Nginx 反代到 3000 端口并配置 HTTPS（腾讯云免费证书或 Let's Encrypt）。HTTPS 下 WebRTC 更稳定，也能避免浏览器对非安全上下文的限制。

## 网络环境说明（IPv4 / IPv6 / NAT）

**两个基本概念**：

| 概念 | 作用 | 本项目对应实现 |
|------|------|----------------|
| **信令服务** | 交换 SDP、ICE 候选，帮助建立 WebRTC 连接；连接建立后**不参与**数据传输 | 单文件模式：微信互发连接码（零服务器）；房间联机：Rust 版 `apps/signaling-rust`（推荐）或 Node `apps/server` WebSocket 中转 |
| **中继服务** | 直连失败时**转发流量**（TURN）；数据传输阶段介入，带宽成本高 | 未内置，见下方「TURN 兜底（里程碑）」 |

一句话区分：**信令只负责"牵线"，线牵成就不干了；中继是"媒婆变传声筒"，全程掺和**。

**STUN 配置**：部署信令服务器时，ICE 服务器列表由服务器经 `GET /config` 动态下发
（默认四枚：腾讯/阿里 + Google×2；`GOMOKU_TURN_URL` 等环境变量可配 TURN），
页面端 `packages/web/src/iceConfig.ts` 获取失败时自动降级到内置同款列表——
**未部署服务器的单文件模式**则由 legacy `public/app.js` 内置「腾讯 + 阿里 STUN 优先，Google 备用」。
国内延迟 30-90ms，远低于 Google 的 150-300ms。STUN 只用于获取公网反射地址（srflx 候选），
**同一局域网或双方全球单播 IPv6 可路由时，浏览器收集的 host 候选即可直连，不依赖 STUN**。

**IPv6 场景（重点）**：WebRTC 的 ICE 默认双栈工作，会同时收集 IPv4 与 IPv6 候选
（含 IPv6 全球单播地址，如 `2408:` / `2409:` / `240e:` 开头）。因此：

- **双方均为全球单播 IPv6**（家宽/校园网/移动数据常见）：无需 STUN、无需 NAT 穿透，
  host 候选里的 IPv6 地址端到端可达，直连成功率比 IPv4 更高——这正是 IPv6 对 P2P 的红利
- **一方 IPv4、一方 IPv6**（双栈）：ICE 自动对全部候选做矩阵探测，走通的那条路径即可
- **纯 IPv6 + 运营商 NAT64/DNS64**：国内 STUN 域名（均无 AAAA 记录）会被 DNS64 合成为
  `64:ff9b::x.x.x.x`，UDP 经 NAT64 映射后仍可用于获取 srflx 候选
- **邀请对局模式天然支持 IPv6**：连接码内的 SDP 已包含全部候选，微信互发后 ICE 自动尝试

> 注意：目前国内公共 STUN（腾讯 `stun.qq.com`、阿里 `stun.aliyun.com`）均只有 IPv4 记录，
> 纯 IPv6 无 DNS64 的网络下它们不可达——此时靠 IPv6 host 候选直连即可，无需担心。

**公网 IPv4 NAT（尽力而为，非承诺范围）**：双方在不同家庭宽带/运营商 NAT 后时，
ICE 会借助腾讯/阿里 STUN 尝试穿透，能否成功取决于双方的 NAT 类型（锥形 NAT 希望较大，
对称型 NAT 基本无望）。连接结果面板会显示实际走的是直连还是穿透。

**TURN 兜底（里程碑）**：对称型 NAT、企业防火墙后，或 IPv6 防火墙严格拦截 UDP 时，
需要自建/租用 TURN 服务器（IPv6 场景需 TURN over IPv6）：

```js
// public/app.js 中的 ICE_SERVERS 增加 TURN 配置
{ urls: ['stun:stun.qq.com:3478', 'turn:your-turn-server:3478'],
  username: 'xxx', credential: 'xxx' }
```

## 对局协议（DataChannel，JSON）

| 消息 | 方向 | 说明 |
|------|------|------|
| `hello {name}` | 双向 | 连接建立后交换昵称 |
| `move {x,y}` | 双向 | 落子（颜色由回合自动推导） |
| `chat {text}` | 双向 | 聊天 |
| `undo-req / undo-ok / undo-no` | 双向 | 悔棋请求/同意/拒绝 |
| `restart-req / restart-ok / restart-no` | 双向 | 重开请求/同意/拒绝 |
| `bye` | 双向 | 离开 |

信令协议（WebSocket `/signal`，仅「房间联机」使用）：`create / join / signal / leave`；
类型唯一定义源在 `packages/shared/src/types.ts`，Rust 版实现见
`apps/signaling-rust/src/protocol/`（消息集合与错误文案同 Node 版逐字一致）。

## 目录结构

```
webrtc-gomoku/
├── packages/
│   ├── core/         # @webrtc-gomoku/core: 五子棋引擎（规则、状态、胜负与悔棋算法）
│   ├── shared/       # @webrtc-gomoku/shared: 信令/对局协议 + deflate-raw base64url 编解码（唯一定义源）
│   └── web/          # @webrtc-gomoku/web: React 19 + CSS Modules + Canvas 棋盘 + 单文件打包
├── apps/
│   ├── server/       # @webrtc-gomoku/server: Node 信令服务器（fallback，协议参考实现）
│   └── signaling-rust/  # M3 v2.0 Rust 信令服务器（tokio+axum+Redis，含 Docker/compose）
├── docs/m3-rust-signaling/ # M3 契约文档：prd / architecture / tasks / deploy + 类图时序图
├── public/           # legacy 单文件版页面（app.js / game-core.js / qrcode / jsqr；test:legacy 的测试对象）
├── build-standalone.js   # legacy 单文件构建（读 public/ 手工运行；现行 dist 产物由 web 的 vite 插件生成）
├── test/             # e2e.js / qr-scan 等 Playwright 脚本
├── dist/             # 构建产物（单文件版，随 Release 分发）
├── ROADMAP.md        # 路线图 / 里程碑
├── MILESTONES.md     # 里程碑执行计划与优先级
└── package.json
```

## 常见问题

- **连不上/卡在"连接建立中"**：当前版本支持同一局域网直连与可达 IPv6 直连；
  公网 IPv4 NAT 场景由 STUN 尽力穿透，失败时面板会给出原因诊断（对称型 NAT 需 TURN，见里程碑）
- **手机玩不了**：单文件版通过微信直接发 HTML 文件即可；确保双方网络可达（同 WiFi 或都有 IPv6）
- **想免手动互发连接码**：部署信令服务器启用「房间联机」——Node 版（`apps/server`）或 M3 Rust 版（`apps/signaling-rust`，推荐：更高并发 + 三层配置 + 热重载），见上文部署章节
