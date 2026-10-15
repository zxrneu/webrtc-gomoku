# WebRTC P2P 五子棋

浏览器之间通过 **WebRTC DataChannel 直连对战**的联机五子棋。服务器只做两件事：托管页面、按房间中转信令（offer/answer/ICE）。**落子、聊天等对局数据全部走 P2P 通道，不经过服务器。**

## 功能

- 15×15 标准棋盘，自由五子棋规则（无禁手），黑方先行，长连也算胜
- 房间联机：4 位房间号 + 邀请链接（`?room=ABCD` 自动填入）
- 手动信令：无需服务器，双方互相复制粘贴连接码即可直连（SDP 经 deflate 压缩，一码约 1-2KB）
- 对局功能：回合制、悔棋（需对方同意）、重新开始、最后一手标记、胜利连线高亮
- 对局聊天、掉线提示、音效（可关）、移动端自适应
- 胜负/平局判定，`/healthz` 健康检查

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

## 关于 NAT 与 TURN

代码内置了 Google 公共 STUN，同一局域网或大多数家用网络可直接 P2P 直连。若双方都在对称型 NAT 或企业防火墙后，直连可能失败，需要自建/租用 TURN 服务器：

```js
// public/app.js 中的 ICE_SERVERS 增加 TURN 配置
{ urls: ['stun:stun.l.google.com:19302', 'turn:your-turn-server:3478'],
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
├── public/
│   ├── index.html       # 页面结构
│   ├── style.css        # 样式
│   ├── app.js           # WebRTC + 对局交互
│   └── game-core.js     # 五子棋纯逻辑（可单测）
├── test/
│   ├── core.test.js    # 逻辑单元测试（node test/core.test.js）
│   └── e2e.js          # 双端联机 E2E（node test/e2e.js）
├── Dockerfile
└── package.json
```

## 常见问题

- **连不上/卡在“连接建立中”**：确认双方都能访问信令服务器；企业网络可能屏蔽 UDP，需 TURN
- **手机玩不了**：确认访问的是局域网 IP（不是 localhost），且防火墙已放行端口
- **房号不存在/已满**：房间仅保留 2 人，房号 4 位字母数字（去掉易混淆字符）
