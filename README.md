# WebRTC P2P 五子棋

浏览器之间通过 **WebRTC DataChannel 直连对战**的联机五子棋。服务器只做两件事：托管页面、按房间中转信令（offer/answer/ICE）。**落子、聊天等对局数据全部走 P2P 通道，不经过服务器。**

## 功能

- 15×15 标准棋盘，自由五子棋规则（无禁手），黑方先行，长连也算胜
- 房间联机：4 位房间号 + 邀请链接（`?room=ABCD` 自动填入）
- 手动信令：无需服务器，双方互相复制粘贴连接码即可直连（SDP 经 deflate 压缩，一码约 1-2KB）
- 对局功能：回合制、悔棋（需对方同意）、重新开始、最后一手标记、胜利连线高亮
- 对局聊天、掉线提示、音效（可关）、移动端自适应
- 胜负/平局判定，`/healthz` 健康检查

## 单文件版（微信互发 · 零服务器）

不想部署服务器？构建一个约 47KB 的单文件 HTML（全部代码内联、无外部依赖），
通过微信文件互发给对方，双方双击打开，用「手动信令」模式互发连接码即可 P2P 对战：

```bash
npm run build    # 生成 dist/gomoku-standalone.html
```

对局步骤（双方都打开单文件后，切到「手动信令」标签）：

1. **邀请方**点「生成邀请码」→ 复制 → 微信发给对方
2. **对方**粘贴邀请码 → 点「生成应答码」→ 复制 → 微信发回
3. **邀请方**粘贴应答码 → 点「完成连接」→ 开始下棋

网络说明：同局域网或双方全球单播 IPv6 时 host 候选直连最快；IPv4 NAT 环境由内置的
腾讯/阿里 STUN 协助穿透（详见下方「网络环境说明」）。也可从 GitHub Release 直接下载现成单文件。

## 本地运行

```bash
cd webrtc-gomoku
npm install
npm start          # 默认 0.0.0.0:3000，可用 PORT=8080 修改
```

- 本机测试：开两个浏览器标签访问 `http://localhost:3000`，一个创建房间、一个加入
- 手机/其他设备：访问启动日志里打印的局域网地址，如 `http://<你的局域网IP>:3000`
- 单元测试：`npm test`（五子棋胜负/悔棋/平局逻辑，11 项）
- E2E 测试：`node test/e2e.js`（需先 `npm i playwright`；用两个浏览器上下文自动打一局，
  覆盖信令链路、落子同步、胜负、聊天、悔棋、重开、手动信令；真实 P2P 连通时自动走真实对局，
  ICE 被环境阻断时自动降级为协议仿真）

## 手动信令玩法（无服务器）

1. 双方都打开页面，切到「手动信令」标签
2. 邀请方点「生成邀请码」→ 复制发给对方
3. 被邀请方粘贴邀请码 →「生成应答码」→ 复制发回
4. 邀请方粘贴应答码 →「完成连接」

适合内网/离线场景，或快速验证 P2P 连通性。

## 架构

```
玩家A 浏览器  <—— DataChannel(P2P) ——>  玩家B 浏览器
    \                                      /
     \  WebSocket 信令(offer/answer/ice)  /
      \                                  /
           信令服务器 server.js (ws)
        （仅牵线；对局数据不经过它）
```

## 部署到腾讯云轻量应用服务器（Lighthouse）

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
- **手动信令模式天然支持 IPv6**：连接码内的 SDP 已包含全部候选，微信互发后 ICE 自动尝试

> 注意：目前国内公共 STUN（腾讯 `stun.qq.com`、阿里 `stun.aliyun.com`）均只有 IPv4 记录，
> 纯 IPv6 无 DNS64 的网络下它们不可达——此时靠 IPv6 host 候选直连即可，无需担心。

**TURN 兜底**：若双方在对称型 NAT、企业防火墙后，或 IPv6 防火墙严格拦截 UDP，直连可能失败，
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

信令协议（WebSocket `/signal`）：`create / join / signal / leave`，详见 `server.js` 注释。

## 目录结构

```
webrtc-gomoku/
├── server.js            # 信令 + 静态服务器（唯一依赖 ws）
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

- **连不上/卡在“连接建立中”**：确认双方都能访问信令服务器；企业网络可能屏蔽 UDP，需 TURN
- **手机玩不了**：确认访问的是局域网 IP（不是 localhost），且防火墙已放行端口
- **房号不存在/已满**：房间仅保留 2 人，房号 4 位字母数字（去掉易混淆字符）
