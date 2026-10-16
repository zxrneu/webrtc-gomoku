# @webrtc-gomoku/web

> 现代响应式 WebRTC 五子棋前端界面与客户端对局引擎。  
> 基于 **React 19 + TypeScript + CSS Modules + Vite** 构建，支持 WebSocket 房间信令与纯前端离线单文件运行。

---

## 🌟 核心特性

- ⚡️ **双模联机架构（Dual-Mode Connectivity）**：
  - **信令房模式**：通过 WebSocket 与信令服务通信，输入 4 位字母房间号秒级匹配、自动完成 SDP 与 ICE 交换。
  - **无网手动模式（零服务器）**：将 WebRTC SDP 深度压缩为高密度文本码与二维码，微信/短信发送或摄像头直接扫码即可对联。
- 🎵 **Web Audio 纯合成音效（零外部资产依赖）**：
  - 彻底摆脱 `.mp3` / `.wav` 静态音频文件；
  - 基于浏览器底层 Web Audio API 物理振荡器，数学模拟木质棋子碰撞声、胜负和弦声与提示音。
- 📷 **扫一扫与图像识别引擎**：
  - 集成 `jsQR` 与 `qrcode-generator`，配备取景框、激光扫描线动效；
  - 既支持调用移动端/电脑摄像头动态扫码，也支持本地相册图片上传识别。
- 🛡️ **严格会话隔离与防穿透（Session Guard）**：
  - 通过 `roomSession.ts` 与 `WebRTCClient.close()` 状态机守卫，在切换房间、对手离开时彻底重置棋盘数据、聊天队列与确认弹窗，杜绝数据残留。
- 📦 **单文件 Standalone 打包黑科技**：
  - 借助 `vite-plugin-singlefile`，一键将所有 HTML、CSS、JS、SVG 及第三方图像库内联打成一个单文件网页（`dist/gomoku-standalone.html`），离线双击即可畅玩。

---

## 🏗️ 架构与数据流图

```mermaid
flowchart TD
    subgraph UI 展示层 [React 19 组件树]
        App[App.tsx 顶层控制器]
        Header[Header: 导航与音效开关]
        Board[Board: 15x15 棋盘/连线/落子动画]
        Status[GameStatus: 双方信息/轮次/悔棋/认输]
        Conn[Connection: 房号联机 / 手动邀请码折叠面板]
        Chat[Chat: 局内点对点文字聊天]
        Modal[ConfirmModal: 悔棋/重开交互弹窗]
        Scanner[ScannerModal: 摄像头取景/相册图片识别]
    end

    App --> Header
    App --> Board
    App --> Status
    App --> Conn
    App --> Chat
    App --> Modal
    App --> Scanner

    subgraph 联机握手链路
        Conn -->|信令模式| WS[WebSocket Client /ws]
        Conn -->|手动模式| QR[qr.ts 二维码生成/识别]
        WS <-->|交换 SDP / ICE| Server[apps/server 信令服务]
    end

    subgraph P2P 对局核心
        App <-->|发送/接收落子与聊天| RTC[webrtc.ts: RTCDataChannel]
        App -->|落子规则校验与胜负判定| Core[@webrtc-gomoku/core]
        App -->|音效触发| Audio[audio.ts: Web Audio 纯合成]
    end
```

---

## 📂 目录结构与模块说明

```text
packages/web/
├── src/
│   ├── components/            # UI 组件层
│   │   ├── Board/             # 棋盘网格绘制、落子动画、胜负连线高亮
│   │   ├── Chat/              # 局内 P2P 实时聊天室
│   │   ├── Connection/        # 房间号联网与手动邀请码控制面板
│   │   ├── GameStatus/        # 对局状态栏（轮次、玩家标签、操作按钮）
│   │   ├── Header/            # 顶部标题栏与全局音效开关
│   │   ├── Modal/             # 确认弹窗（对手请求悔棋、再来一盘协商）
│   │   ├── Scanner/           # 摄像头实时扫码与相册图片解析弹窗
│   │   └── Toast/             # 轻量浮层即时消息通知
│   ├── webrtc.ts              # WebRTC 连接控制器（PeerConnection、DataChannel、ICE 管理）
│   ├── iceConfig.ts           # STUN/TURN 路由嗅探（向 /config 动态拉取与默认兜底）
│   ├── roomSession.ts         # 房间会话管理（创建纯净状态、换房与离开时复位）
│   ├── qr.ts                  # Canvas 二维码生成与 jsQR 图像解码
│   ├── audio.ts               # Web Audio API 声音合成引擎（落子音、胜利音、提示音）
│   ├── types.ts               # 前端交互私有类型（弹窗状态、扫码类型、聊天项）
│   ├── App.tsx                # 顶层状态协调器（状态机驱动业务闭环）
│   ├── main.tsx               # React 根节点挂载入口
│   └── styles/                # 全局样式与 CSS 变量系统
├── test/                      # 前端单元测试（Vitest）
│   ├── webrtc.test.ts         # WebRTC 客户端换房生命周期测试
│   ├── iceConfig.test.ts      # ICE 服务器拉取与降级容错测试
│   └── roomSession.test.ts    # 房间会话防残留测试
├── index.html                 # Vite HTML 模板
├── vite.config.ts             # Vite 配置（含 React 插件与 singlefile 单文件内联插件）
└── package.json
```

---

## 🛠️ 本地开发与常用命令

在项目根目录下执行：

```bash
# 启动前端开发调试服务器（支持 HMR 热更新）
pnpm dev
# 或定向运行
pnpm --filter @webrtc-gomoku/web dev

# 构建生产版本（生成普通 dist/ 资源包与单文件 gomoku-standalone.html）
pnpm --filter @webrtc-gomoku/web build

# 预览生产构建效果
pnpm --filter @webrtc-gomoku/web preview

# 运行前端模块全部单元测试
npx vitest run packages/web/test/

# 运行前端单元测试监听模式（开发测试边写边调）
npx vitest packages/web/test/
```

---

## 🧩 技术栈选型

| 领域 | 依赖项 | 选用原因 |
| :--- | :--- | :--- |
| **视图框架** | React 19 | 最新 React 版本，极致性能与简洁的 Hooks 状态管理 |
| **样式方案** | CSS Modules | 样式天然局部隔离，无运行时开销，完全零外部 CSS 库依赖 |
| **构建工具** | Vite 6 | 极速冷启动，秒级 HMR，生态兼容完善 |
| **打包内联** | `vite-plugin-singlefile` | 将 JS、CSS 与 HTML 合并为单文件，无需 Node 服务即可离线分发 |
| **图像识别** | `jsQR` | 纯 JavaScript 扫码解码库，无 WebAssembly 兼容性门槛，手机与 PC 均流畅识别 |
| **二维码生成** | `qrcode-generator` | 超轻量级 SVG/Canvas 二维码渲染器 |
| **单元测试** | Vitest | 与 Vite 共享转换管道，毫秒级断言响应 |
