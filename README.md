# WebRTC P2P 五子棋

浏览器之间通过 **WebRTC DataChannel 直连对战**的联机五子棋。**零服务器**：单文件 HTML 通过微信互发，双方互发连接码即建立 P2P 直连，落子、聊天等对局数据全部在两端之间传输。

> 第一原则不变：单文件微信互发永远可用。可选的「房间联机」（自动牵线）现在由 **M3 v2.0 Rust 信令服务器**承载（`apps/signaling-rust`），不需要时一行部署都不用做。

## 当前支持

- **同一局域网直连**：同一 WiFi/内网下 IPv4 host 候选直连，无需任何服务器
- **可达 IPv6 直连**：双方全球单播 IPv6（`2408:`/`2409:` 等）端到端可达，
  host 候选直连——**无 NAT、无需 STUN**，这是 IPv6 对 P2P 的红利
- **微信互发邀请**：单文件 HTML（当前构建约 628KB，零运行时依赖）+ 连接码互发，交互式引导流程
- **扫码配对**：双向二维码 + BarcodeDetector/jsQR 双模识别 + 相册兜底
- **对局功能**：15×15 棋盘、回合制、悔棋（需对方同意）、重新开始、最后一手标记、
  胜利连线高亮、对局聊天、掉线提示、音效开关、移动端自适应
- **富媒体聊天**：图片、文件与最长 60 秒的语音消息，支持大文件接收确认、进度、取消和下载；使用与保存规则见[聊天说明](docs/chat-media.md)。实时语音和视频通话仍为后续规划。
- **连接透明度**：连接成功后显示实际传输方式（IPv6 直连 / IPv4 直连 /
  NAT 穿透 / TURN 中继）；连不上时给出原因诊断
- **STUN/TURN 动态下发（v2.0 新增）**：部署信令服务器后，ICE 服务器列表改由
  `GET /config` 下发（`packages/web/src/iceConfig.ts`），失败自动降级到内置同款列表
- **本地人机对战（v2.1 / M5 新增）**：纯客户端本地运行（Web Worker 独立线程 + 主线程分片降级），
  零网络依赖、离线单文件直接可用；支持 3 档难度（简单/普通/最强）与先后手选择；最强档采用
  **证明数搜索（PNS）** 与 **威胁依赖分析**，具备深度连杀攻杀（VCT/VCF）与严密的反杀自检防守。

## 服务大厅（初版）

在线构建新增独立 `/lobby` 页面：查看在线棋友、按昵称搜索、定向邀请组房、快速匹配、公开建房与加入。组房成功自动进入棋盘，落子与聊天继续走 P2P。当前窗口刷新可在服务端宽限期内恢复房间和棋谱。

**Node `apps/server` 与 Rust `apps/signaling-rust` 均支持大厅**：Node 运行 `pnpm build && pnpm start` 后访问 `/lobby`；本地开发同时启动 `pnpm dev:server` 和 `pnpm dev`。Rust 启动方式见 [Rust 服务说明](apps/signaling-rust/README.md)。初版在线名册、邀请和匹配队列按服务节点维护，Rust 原有 Redis 跨节点房间信令与座位恢复机制继续可用。

`pnpm build` 分别生成在线版本 `packages/web/dist/index.html` 和剔除大厅的单文件 `dist/gomoku-standalone.html`。文档入口见 [服务大厅](docs/m6-lobby/README.md)。

Rust 大厅使用定向即时通知与每秒合并发布：无状态变化不广播，浏览器仍每 5 秒单独查询。每节点最多 2000 个大厅会话，大厅准入在本节点总房间数达到 1000 时拒绝；实际承载量需按部署环境验证。运行边界与测试命令见[大厅说明](docs/m6-lobby/README.md)。

使用、部署与设计说明见[文档导航](docs/README.md)，后续功能范围见[路线图](ROADMAP.md)。

> 公网 IPv4 NAT 穿透（双方在不同家庭宽带后）：代码已内置腾讯/阿里公共 STUN 尽力尝试，
> 成功率取决于 NAT 类型，**不在当前版本的支持承诺范围内**。

## Monorepo 工程架构（pnpm workspace）

项目已全面迁移为 TypeScript Monorepo，模块边界清晰且支持现代 React 与独立单文件打包：

```
webrtc-gomoku/
├── packages/
│   ├── core/         # @webrtc-gomoku/core: 纯 TypeScript 五子棋引擎（规则、状态、AI 搜索、PNS 算杀与胜法证书）
│   ├── shared/       # @webrtc-gomoku/shared: 共享信令与对局协议、deflate-raw + base64url 压缩编解码
│   └── web/          # @webrtc-gomoku/web: React 19 + CSS Modules + Canvas 15×15 棋盘 + Vite 单文件打包
├── apps/
│   ├── server/       # @webrtc-gomoku/server: TypeScript HTTP 静态托管与 WebSocket 信令中继服务
│   └── signaling-rust/ # Rust 信令、单节点大厅、Redis 跨节点房间与静态托管
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

## 局域网 HTTPS 与语音消息

Node、Rust 构建版与 Vite 开发版均支持配置证书启动 HTTPS，网页与信令使用同一端口的 HTTPS/WSS。局域网发送语音时，双方设备都需要信任证书并允许麦克风访问；普通局域网 HTTP 仍可下棋，但无法录音。证书生成、手机信任、启动命令及公网反代见 **[HTTPS 与语音配置](docs/https.md)**。

运行 `pnpm https:setup` 可直接下载 mkcert 二进制、配置本机 CA 并生成局域网证书；可用 `--ip 192.168.1.100` 指定地址。Node 使用 `pnpm build && pnpm start:https`，Rust 使用 `pnpm build:web && pnpm start:https:rust`，默认访问证书覆盖的局域网 IP 的 HTTPS 3443 端口。

当前阿里云公网实例的证书签发、自动续签、进程说明与管理命令见 [阿里云运维手册](docs/aliyun-operations.md)。

## 快速开始与本地开发

先安装 Git、Node.js 和 pnpm。普通前端与 Node 开发不需要 Rust、Redis、mkcert；使用 Rust 服务时再安装 Rust stable、rustfmt 和 Clippy。工具链入口为 [Node](https://nodejs.org/en/download)、[pnpm](https://pnpm.io/installation) 和 [rustup](https://rustup.rs/)。

| 工具 | 仓库依据与验证范围 |
| --- | --- |
| Node.js | 当前 Vite / Vitest 依赖声明支持 Node 18、20 或 22+；本地已验证 26.3.0，其他版本按锁文件安装后验证 |
| pnpm | 锁文件格式为 9；本地已验证 9.15.4。仓库尚未用 `packageManager` 固定统一版本，Dockerfile 单独指定其构建版本 |
| Rust（可选） | `apps/signaling-rust/rust-toolchain.toml` 选择 stable；本地已验证 rustc 1.96.1。Cargo 包声明的最低版本不等于整份锁定依赖均验证过该下限 |
| 浏览器测试（可选） | Google Chrome 和 Playwright；HTTPS 集成测试还需要 OpenSSL，见[测试准备](docs/testing.md#准备环境) |

在仓库根目录先执行一次安装、构建和单测。这里的命令使用 Bash / POSIX 环境变量写法；Windows 可用 WSL2，PowerShell 的 HTTPS 写法另见[证书说明](docs/https.md)。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

开发时打开两个终端，不要把前后端启动命令顺序放在同一前台终端等待：

```bash
# 终端一：Node 信令服务，默认 HTTP 3000
pnpm dev:server

# 终端二：Vite 前端，默认 HTTP 5173，代理后端 3000
pnpm dev
```

访问 `http://localhost:5173/lobby`。验证生产构建时，停止开发后端并运行 `pnpm start`，访问 `http://localhost:3000/lobby`。用两个页面完成邀请或组房，再检查真实落子同步；单文件版按上文互发连接码连接。

替换为 Rust 后端时，停止终端一的 Node 服务，在仓库根运行下面命令；Vite 仍使用 5173：

```sh
GOMOKU_PORT=3000 GOMOKU_REDIS_ENABLED=false GOMOKU_PUBLIC_DIR=packages/web/dist \
  cargo run --locked --manifest-path apps/signaling-rust/Cargo.toml
```

如果服务端口改为其他值，要同步调整 Vite 代理；当前代理固定指向本机 3000。Ctrl-C 停止各前台服务。首次依赖安装后出现工作区模块缺失时重新执行 `pnpm build`；不要让 Node 和 Rust 同时占用 3000。局域网录音按 [HTTPS 配置](docs/https.md)启动，普通 LAN HTTP 无法录音。

单测、Rust 质量检查、浏览器安装、Node / Rust E2E、单文件与真实 TURN 验收，统一见[测试与兼容性](docs/testing.md)。胜法证书 CLI 见 [AI 运行说明](docs/m5-ai/engine-upgrade.md#离线求解与复验)。

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

**生产 HTTPS**：可使用带公共 CA 证书的反向代理，或 Node/Rust 原生 TLS。仓库包含 Caddy 配置与完整的 [HTTPS 部署和语音权限说明](docs/https.md)。

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
├── docs/             # 需求、架构、部署与运维说明；入口为 docs/README.md
├── public/           # legacy 单文件版页面（app.js / game-core.js / qrcode / jsqr；test:legacy 的测试对象）
├── test/             # e2e.js / qr-scan 等 Playwright 脚本
├── dist/             # 构建产物（单文件版，随 Release 分发）
├── ROADMAP.md        # 路线图 / 里程碑
└── package.json
```

## 常见问题

- **连不上/卡在"连接建立中"**：当前版本支持同一局域网直连与可达 IPv6 直连；
  公网 IPv4 NAT 场景由 STUN 尽力穿透，失败时面板会给出原因诊断（对称型 NAT 需 TURN，见里程碑）
- **手机玩不了**：单文件版通过微信直接发 HTML 文件即可；确保双方网络可达（同 WiFi 或都有 IPv6）
- **想免手动互发连接码**：部署信令服务器启用「房间联机」——Node 版（`apps/server`）或 M3 Rust 版（`apps/signaling-rust`，推荐：更高并发 + 三层配置 + 热重载），见上文部署章节
