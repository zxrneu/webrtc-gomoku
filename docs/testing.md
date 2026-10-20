# 测试与浏览器兼容性

首次安装、工具链与双终端开发步骤见[快速开始](../README.md#快速开始与本地开发)。以下命令都在仓库根目录运行。

## 准备环境

`pnpm test` 使用 Vitest，测试范围由 [vitest.config.ts](../vitest.config.ts) 指定，不需要浏览器或在线服务。Rust 测试单独执行，其中集成测试会启动回环端口。

浏览器测试使用 Playwright。整套测试中的部分脚本固定选择 `channel: 'chrome'`，因此仅安装 Playwright Chromium 不足以运行全部脚本；需要系统 Google Chrome，或执行下面的安装命令。Linux 缺系统库时使用 Playwright 的 `install-deps`。

```sh
# 已安装 Google Chrome 时可跳过第一条；它会下载并安装浏览器
pnpm exec playwright install chrome
# Linux 浏览器缺少系统依赖时执行，可能请求管理员权限
pnpm exec playwright install-deps chromium
```

HTTPS 集成测试还需要支持 `req -addext` 的 OpenSSL。`pnpm test:https` 会创建临时证书，不安装系统 CA；它不替代手机信任 CA 和真实麦克风授权的验证。

## 按变更选择检查

| 范围 | 命令 | 前置条件 |
| --- | --- | --- |
| 常规构建、单测 | `pnpm build && pnpm test` | 已安装 workspace 依赖 |
| 纯旧版 JS 引擎 | `pnpm test:legacy` | Node |
| Rust 服务 | `cargo test --locked --manifest-path apps/signaling-rust/Cargo.toml` | Rust；允许回环端口 |
| Rust 格式与静态检查 | 下方 `cargo fmt`、`cargo clippy` | rustfmt、Clippy |
| 完整浏览器回归 | `REQUIRE_P2P=1 pnpm test:e2e` | Chrome、构建产物、运行中的 HTTP 服务、OpenSSL |
| HTTPS / WSS / 语音 | `pnpm test:https` | 构建产物、Chrome、OpenSSL；脚本自行启停测试实例 |
| 单文件离线版 | `node test/standalone-check.js` | Chrome、`dist/gomoku-standalone.html` |
| 二维码 | `pnpm test:qr` | Chrome、单文件构建产物 |
| 大厅协议与窗口 | [大厅测试](m6-lobby/README.md#测试) | 独立 HTTP 实例；共享队列的用例串行 |

```sh
cargo fmt --manifest-path apps/signaling-rust/Cargo.toml --check
cargo clippy --locked --manifest-path apps/signaling-rust/Cargo.toml --all-targets -- -D warnings
```

## Node 与 Rust 双端运行

先构建一次；下面 A / B 两种主服务任选一种，不能同时占用 3000 端口。服务保持在前台，便于测试结束后用 Ctrl-C 停止。

```sh
pnpm build

# A：终端一，Node 主服务
unset TLS_CERT_FILE TLS_KEY_FILE
HOST=127.0.0.1 PORT=3000 pnpm start

# B：替代 A，终端一，Rust 主服务
GOMOKU_HOST=127.0.0.1 GOMOKU_PORT=3000 GOMOKU_REDIS_ENABLED=false \
  GOMOKU_PUBLIC_DIR=packages/web/dist \
  cargo run --locked --manifest-path apps/signaling-rust/Cargo.toml
```

终端二执行：

```sh
BASE=http://127.0.0.1:3000 REQUIRE_P2P=1 pnpm test:e2e
```

这会把支持 `BASE` 的页面测试指向主服务；媒体脚本默认另起 Node 3105 实例，HTTPS 脚本默认另起 Node 3106 实例。不能仅因主服务使用 Rust 就声称全套子脚本都使用 Rust。

要将真实富媒体检查也指向 Rust 主服务，并将 HTTPS 子测试切为 Rust：

```sh
# 先确保 Rust 调试二进制存在
cargo build --locked --manifest-path apps/signaling-rust/Cargo.toml
BASE=http://127.0.0.1:3000 MEDIA_BASE=http://127.0.0.1:3000 \
  HTTPS_SERVER=rust REQUIRE_P2P=1 pnpm test:e2e

# 或单独验证 Rust 原生 HTTPS
HTTPS_SERVER=rust pnpm test:https
```

自定义 Cargo 产物目录时，HTTPS 脚本支持 `RUST_SERVER_BIN` 或 `CARGO_TARGET_DIR`；`HTTPS_TEST_PORT` 可修改默认 3106。`BASE` 不会自动改写所有脚本的内部监听端口。测试前清除继承的 `TLS_CERT_FILE` / `TLS_KEY_FILE`，避免预期 HTTP 的辅助 Node 实例意外以 HTTPS 启动。

## 真实连接与协议仿真

- 默认 `test/e2e.js` 在网络阻断真实 WebRTC 时可降级为消息处理仿真；这只说明协议处理通过。
- `REQUIRE_P2P=1` 要求真实 DataChannel 打开；发布连通性验证使用此模式。
- `REQUIRE_RELAY=1` 在主对局脚本中额外要求选中的候选对为 TURN relay；需要主实例下发可用 TURN，见 [TURN 验收](turn.md#验收与排障)。它不强制所有子脚本都走中继。
- `test/media-real-p2p.e2e.js` 使用真实 PeerConnection 和录制/传输流程，但自动化注入了测试音源及权限；真机麦克风、耳机、系统权限和切后台行为需另外验证。
- HTTPS 子测试显式信任或忽略其临时证书错误；不能据此宣称开发根证书已被手机信任。

测试退出非零即失败。先看最早的异常和对应服务日志，不要把健康检查成功当成真实对局通过。浏览器和临时辅助服务由脚本清理；手动启动的主服务需要自行停止。截图、探针结果写入 `output/`，不要把含真实地址、昵称或会话信息的结果直接加入 Git。

## 浏览器与运行方式

“自动化覆盖”只表示仓库有对应测试流程，不代表所有浏览器版本、真实设备和网络均已验证。

| 环境 | 当前验证范围 | 仍需确认 |
| --- | --- | --- |
| 桌面 Google Chrome，localhost HTTP | 自动化覆盖大厅、对局、附件和测试音源录音 | 真麦克风、不同网络、浏览器升级后的行为 |
| 桌面 Google Chrome，HTTPS | 自动化覆盖 HTTPS/WSS、真实 P2P 和语音传输 | 每台设备的证书信任、真实权限与音频设备 |
| 桌面 Google Chrome，`file://` 单文件 | 自动化覆盖手动连接、真实 P2P 和离线页面 | 单文件录音与跨设备媒体编码兼容性不作承诺 |
| 普通局域网 HTTP | 录音不可用提示有回归覆盖 | 双方应改用可信 HTTPS 后验证语音 |
| Edge / Firefox / Safari 桌面 | 尚无完整的对应浏览器回归矩阵 | 对局、文件保存、录音格式及播放 |
| iOS / Android 系统浏览器 | 有窄屏布局模拟，不能视为真机验证 | CA 信任、权限、音频播放、内存和后台恢复 |
| 微信内置浏览器 | 未建立正式真机验证矩阵 | 文件打开、WebRTC、录音权限；失败时用系统浏览器复试 |

浏览器录音能力由 `getUserMedia`、`MediaRecorder` 与双方能力协商决定；普通 LAN HTTP、`file://`、localhost 和可信 HTTPS 不应合并成一个“支持录音”的结论。Chrome 的 `CHROME_PATH` 回退只在部分脚本生效，不是全仓库通用的浏览器路径开关。
