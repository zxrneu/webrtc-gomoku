# WebRTC P2P 五子棋

浏览器之间通过 **WebRTC DataChannel 直连对战**的联机五子棋。**零服务器**：单文件 HTML 通过微信互发，双方互发连接码即建立 P2P 直连，落子、聊天等对局数据全部在两端之间传输。

## 当前支持（v1.1）

- **同一局域网直连**：同一 WiFi/内网下 IPv4 host 候选直连，无需任何服务器
- **可达 IPv6 直连**：双方全球单播 IPv6（`2408:`/`2409:` 等）端到端可达，
  host 候选直连——**无 NAT、无需 STUN**，这是 IPv6 对 P2P 的红利
- **微信互发邀请**：单文件 HTML（47KB 零依赖）+ 连接码互发，交互式引导流程
- **对局功能**：15×15 棋盘、回合制、悔棋（需对方同意）、重新开始、最后一手标记、
  胜利连线高亮、对局聊天、掉线提示、音效开关、移动端自适应
- **连接透明度**：连接成功后显示实际传输方式（IPv6 直连 / IPv4 直连 /
  NAT 穿透 / TURN 中继）；连不上时给出原因诊断

## 里程碑（规划中）

- **房间联机**：WebSocket 信令服务器按房间自动牵线，免去手动互发连接码（需部署服务端，
  当前版本未启用；代码保留在 `server.js`，部署方法见下文）
- **TURN 中继**：对称型 NAT / 严格防火墙下的兜底中转
- **域名 + HTTPS**：生产部署与更稳定的浏览器兼容

> 公网 IPv4 NAT 穿透（双方在不同家庭宽带后）：代码已内置腾讯/阿里公共 STUN 尽力尝试，
> 成功率取决于 NAT 类型，**不在当前版本的支持承诺范围内**。

## 单文件版（微信互发 · 零服务器）

不想部署服务器？构建一个约 47KB 的单文件 HTML（全部代码内联、无外部依赖），
通过微信文件互发给对方，双方双击打开，用「手动信令」模式互发连接码即可 P2P 对战：

```bash
npm run build    # 生成 dist/gomoku-standalone.html
```

对局步骤（双方都打开单文件后，切到「手动信令」标签）：

1. **邀请方**点「创建房间」→ 邀请码自动生成 → 复制 → 微信发给对方
2. **对方**点「加入房间」→ 粘贴邀请码 →「生成应答码」→ 复制 → 微信发回
3. **邀请方**粘贴应答码 → 点「完成连接」→ 开始下棋

网络说明：**同一局域网或双方可达 IPv6 时自动直连**（当前版本支持范围）；
连不上时面板会给出原因诊断。也可从 GitHub Release 直接下载现成单文件。

## 本地运行（开发 / 里程碑：房间联机）

> 以下为开发者选项：运行信令服务器后可启用「房间联机」（自动牵线，免手动互发连接码），
> 属于里程碑功能，当前版本主路径为上面的单文件微信互发。

```bash
cd webrtc-gomoku
npm install
npm start          # 默认 0.0.0.0:3000，可用 PORT=8080 修改
```

- 本机测试：开两个浏览器标签访问 `http://localhost:3000`，一个创建房间、一个加入
- 手机/其他设备：访问启动日志里打印的局域网地址，如 `http://<你的局域网IP>:3000`
- 单元测试：`npm test`（五子棋胜负/悔棋/平局逻辑，11 项）
- E2E 测试：`node test/e2e.js`（需先 `npm i playwright`；用两个浏览器上下文自动打一局，
  覆盖信令链路、落子同步、胜负、聊天、悔棋、重开、邀请对局流程；真实 P2P 连通时自动走真实对局，
  ICE 被环境阻断时验证失败诊断）
- 单文件版验证：`node test/standalone-check.js`

## 架构

```
当前版本（v1.1 · 零服务器）：

  玩家A 浏览器  <—— DataChannel(P2P 直连) ——>  玩家B 浏览器
      连接码（邀请/应答）经微信等任意聊天工具互发

里程碑（房间联机，需部署 server.js）：

  玩家A 浏览器  <—— DataChannel(P2P) ——>  玩家B 浏览器
      \                                      /
       \  WebSocket 信令(offer/answer/ice)  /
        \                                  /
             信令服务器 server.js (ws)
          （仅牵线；对局数据不经过它）
```

## 里程碑：部署信令服务器到腾讯云轻量应用服务器（Lighthouse）

> 仅当你要启用「房间联机」（自动牵线）时才需要部署；单文件微信互发模式不需要任何服务器。

**方式一：Node 直接运行（最快）**

```bash
# 1. 安装 Node.js 18+（Debian/Ubuntu 镜像）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs

# 2. 上传代码到服务器（如 /opt/webrtc-gomoku），安装依赖
npm install --omit=dev

# 3. 启动（任选其一）
PORT=3000 node server.js                      # 前台
nohup node server.js > gomoku.log 2>&1 &      # 后台
pm2 start server.js --name gomoku             # pm2 守护（推荐）
```

4. **放行端口**：轻量控制台 → 实例 → 防火墙 → 添加规则，放行 TCP `3000`（入站）
5. 访问 `http://<服务器公网IP>:3000`

**方式二：Docker**

```bash
docker build -t gomoku .
docker run -d --name gomoku -p 3000:3000 --restart unless-stopped gomoku
```

**生产建议**：用 Nginx 反代到 3000 端口并配置 HTTPS（腾讯云免费证书或 Let's Encrypt）。HTTPS 下 WebRTC 更稳定，也能避免浏览器对非安全上下文的限制。

## 网络环境说明（IPv4 / IPv6 / NAT）

**两个基本概念**：

| 概念 | 作用 | 本项目对应实现 |
|------|------|----------------|
| **信令服务** | 交换 SDP、ICE 候选，帮助建立 WebRTC 连接；连接建立后**不参与**数据传输 | 单文件模式：微信互发连接码（零服务器）；房间联机（里程碑）：`server.js` WebSocket 中转 |
| **中继服务** | 直连失败时**转发流量**（TURN）；数据传输阶段介入，带宽成本高 | 未内置，见下方「TURN 兜底（里程碑）」 |

一句话区分：**信令只负责"牵线"，线牵成就不干了；中继是"媒婆变传声筒"，全程掺和**。

**STUN 配置**：`public/app.js` 中 ICE_SERVERS 采用「腾讯 + 阿里 STUN 优先，Google 备用」——
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

信令协议（WebSocket `/signal`，仅里程碑「房间联机」使用）：`create / join / signal / leave`，详见 `server.js` 注释。

## 目录结构

```
webrtc-gomoku/
├── server.js            # 信令 + 静态服务器（里程碑：房间联机；单文件模式不需要）
├── build-standalone.js  # 单文件构建（npm run build → dist/gomoku-standalone.html）
├── public/
│   ├── index.html       # 页面结构
│   ├── style.css        # 样式
│   ├── app.js           # WebRTC + 对局交互
│   └── game-core.js     # 五子棋纯逻辑（可单测）
├── test/
│   ├── core.test.js    # 逻辑单元测试（node test/core.test.js）
│   ├── standalone-check.js  # 单文件版验证（node test/standalone-check.js）
│   └── e2e.js          # 双端联机 E2E（node test/e2e.js）
├── dist/               # 构建产物（单文件版，随 Release 分发）
├── Dockerfile
└── package.json
```

## 常见问题

- **连不上/卡在"连接建立中"**：当前版本支持同一局域网直连与可达 IPv6 直连；
  公网 IPv4 NAT 场景由 STUN 尽力穿透，失败时面板会给出原因诊断（对称型 NAT 需 TURN，见里程碑）
- **手机玩不了**：单文件版通过微信直接发 HTML 文件即可；确保双方网络可达（同 WiFi 或都有 IPv6）
- **想免手动互发连接码**：部署 `server.js` 启用「房间联机」（里程碑功能，见上文部署章节）
