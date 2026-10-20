# HTTPS、局域网语音与部署

局域网发送语音消息需要浏览器信任的 HTTPS 页面，并由用户允许麦克风访问。普通 `http://192.168.x.x` 可以联机下棋，但不满足录音的安全上下文要求；`http://localhost` 是本机开发的特殊情况，不能用于判断手机访问是否可录音。[浏览器说明](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

Node 和 Rust 服务均支持同一端口提供 HTTPS 网页、`/config`、`/healthz` 和 WSS `/signal`。Vite 开发服务也支持 HTTPS。公网可选用下文的反向代理统一管理证书。所有命令均在仓库根执行，除明确标记的 PowerShell 外采用 Bash/Zsh 语法。

## 1. 局域网：生成受信任的开发证书

在仓库根运行以下命令，macOS、Linux 和 Windows PowerShell 使用同样的命令（需要 Node.js 18+）：

```bash
pnpm https:setup
```

[配置脚本](../scripts/setup-https.mjs) 会识别系统和 CPU 架构，直接从 [mkcert 官方 Release](https://github.com/FiloSottile/mkcert/releases/tag/v1.4.4)下载 v1.4.4 二进制到 `.certs/bin/`，校验其版本，并完成以下操作：

1. 复用或生成本项目的 CA（`.certs/ca/`），调用 `mkcert -install` 安装到本机信任库。系统可能要求管理员授权；Windows 权限不足时使用管理员终端重试。Linux/Firefox 可能需要按 mkcert 提示安装 `certutil`/NSS 工具。
2. 自动探测常见内网 IPv4，过滤常见 VPN/容器接口；将探测地址与 `localhost`、`127.0.0.1`、`::1` 一起写入证书 SAN。
3. 生成 Node 和 Rust 共用的 `.certs/lan-cert.pem`、`.certs/lan-key.pem`，并单独导出手机可安装的 CA 公有证书 `.certs/rootCA.pem`。

首次运行需要能够访问 GitHub。二进制保存在项目内，后续重跑会复用；脚本不会通过 Homebrew、Chocolatey 或 Scoop 安装，也不修改全局 PATH。下载或 CA 安装失败会中止并报错。

多网卡、自定义网段或自动识别不准确时，明确指定手机实际访问的地址；`--ip` 和 `--host` 都可以重复：

```bash
pnpm https:setup --ip 192.168.1.100
pnpm https:setup --ip 192.168.1.100 --ip 2001:db8::1234 --host gomoku.local
# 仅生成证书，不安装本机信任；浏览器使用前仍须安装 CA：
pnpm https:setup --no-trust --ip 192.168.1.100
```

指定 `--ip` 后会覆盖自动探测的 IP；`--host` 只增加 SAN，不会配置 DNS，主机名仍需设备自行解析。未探测到局域网地址时只生成本机证书，并提示使用 `--ip` 重跑。证书 SAN 必须包含浏览器地址栏使用的 IP 或主机名；换 Wi-Fi、IP 变化或证书过期后重跑并重启服务。重复生成服务器证书会沿用 `.certs/ca/` 中的 CA，无需手机重复信任。CA 目录被删除或更换后，则须在每台设备重新安装新的 CA。

mkcert 面向自己的开发设备。手机只传输 `.certs/rootCA.pem`；不要分享 `.certs/ca/rootCA-key.pem`、`.certs/lan-key.pem` 或整个 `.certs/` 目录。证书与私钥均已被 Git 忽略，不要放入 `public/`、`dist/` 等静态目录。[mkcert 移动设备说明](https://github.com/FiloSottile/mkcert#mobile-devices)

只有显式运行 `https:setup` 的默认模式才会安装本机信任；常规构建、测试和 HTTPS 启动命令不会自动安装 CA。手机仍需按下一节手动信任。

## 2. 手机和其他电脑必须单独信任 CA

电脑上执行 `mkcert -install` 只影响该电脑。每个接收/发送语音的设备都需要信任同一个 CA，页面不得出现证书警告。

- **iPhone/iPad**：通过 AirDrop 等方式将 `rootCA.pem` 传给自己的设备；打开证书，进入“设置 → 已下载描述文件”（或“通用 → VPN 与设备管理”）安装。然后进入“设置 → 通用 → 关于本机 → 证书信任设置”，为该 CA 开启完全信任。仅安装描述文件还不够。[Apple 官方步骤](https://support.apple.com/en-us/102390)
- **Android**：把 `rootCA.pem` 传到自己的手机，在设置中搜索“安装证书”，选择 **CA 证书**，安装到用户受信任凭据。菜单位置随厂商/版本变化，可从“安全与隐私 → 更多安全设置 → 加密与凭据”寻找。随后用支持用户 CA 的系统浏览器打开页面并确认无证书警告；应用内浏览器、WebView 和受管设备可能不接受用户 CA，改用完整浏览器或公网受信任域名。设备凭据入口见 [Google 官方说明](https://support.google.com/pixelphone/answer/2844832)。
- **另一台电脑**：导入该 `rootCA.pem` 到其系统/浏览器受信任根证书存储；Firefox 使用独立存储时还需导入到 Firefox。只导入你自己生成并核对过的 CA。

安装后重新打开浏览器；仍有证书错误时先解决信任或域名/IP 不匹配问题。点击“继续访问”或浏览器忽略证书错误开关，不是本项目对手机录音的配置方案。测试结束可在设备凭据/描述文件设置中删除本次开发 CA。

## 3. 构建版：一条启动命令提供 HTTPS + WSS

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start:https
```

默认读取第 1 节生成的 `.certs/lan-cert.pem` 和 `.certs/lan-key.pem`，在 3443 端口启动 Node。自定义证书或端口也可显式运行 `TLS_CERT_FILE=.certs/lan-cert.pem TLS_KEY_FILE=.certs/lan-key.pem HOST=0.0.0.0 PORT=3443 pnpm start`。

Windows PowerShell：

```powershell
$env:TLS_CERT_FILE = '.certs/lan-cert.pem'
$env:TLS_KEY_FILE = '.certs/lan-key.pem'
$env:HOST = '0.0.0.0'
$env:PORT = '3443'
pnpm start
```

手机连接同一 Wi-Fi，访问 `https://192.168.1.100:3443/lobby`，地址必须与证书 SAN 一致。放行主机防火墙 TCP 3443；路由器的访客 Wi-Fi/AP 隔离也可能阻止设备互连。服务启动日志会打印 HTTPS 与 WSS 地址。

| 配置 | 行为 |
|---|---|
| 不设置 `TLS_CERT_FILE` / `TLS_KEY_FILE` | 保留原有 HTTP + WS，默认端口 3000 |
| 两个变量均设置 | 启用 HTTPS + WSS；端口仍由 `PORT` 决定，不会自动改为 443 |
| 只设置一个，或文件不可读 | 启动失败并说明对应配置项，避免意外退回 HTTP |
| 相对证书路径 | 固定相对仓库根解析；`pnpm --filter` 改变工作目录也不影响 |
| 绝对证书路径 | 可由部署环境注入；仓库中不保存机器路径 |

证书须为 PEM，私钥须可直接读取，最低 TLS 1.2；生产证书链通常使用 CA 提供的 fullchain 文件。证书格式错误、密钥不匹配等由 TLS 层拒绝启动。更新证书后重启服务。此模式仅监听一个 HTTPS 端口，不另外提供 HTTP 跳转。

### Rust 原生 HTTPS + WSS

Rust 与 Node 使用同一对证书变量，直接监听 HTTPS 端口，不要求先安装反向代理。完成第 1 节证书配置后运行：

当前 Rust 入口使用 Unix 信号处理，Rust 启动命令适用于 macOS/Linux；Windows 可使用 Node HTTPS 服务。证书下载脚本本身支持 Windows。

```bash
pnpm build:web
pnpm start:https:rust
```

也可显式启动（首次先构建前端）：

```bash
pnpm build
TLS_CERT_FILE=.certs/lan-cert.pem TLS_KEY_FILE=.certs/lan-key.pem GOMOKU_HOST=0.0.0.0 GOMOKU_PORT=3443 GOMOKU_REDIS_ENABLED=false GOMOKU_PUBLIC_DIR=packages/web/dist cargo run --manifest-path apps/signaling-rust/Cargo.toml
```

访问 `https://你的局域网IP:3443/lobby`，设备信任要求与 Node 完全相同。`GOMOKU_REDIS_ENABLED=false` 适用于本地单节点；部署已有 Redis 时按原配置启用。发布运行可给 Cargo 添加 `--release`，或直接运行构建产物。

Rust 运行在仓库内时，从当前目录向上定位 `pnpm-workspace.yaml`，因此从仓库根或 Rust 包目录启动都能解析同一组相对证书路径。独立二进制不在仓库中时，默认相对启动工作目录解析，也可用 `GOMOKU_REPO_ROOT` 指定部署根，或通过环境变量传入绝对证书路径。源码不会固化构建机器路径。

Rust 证书必须包含有效证书链和匹配的未加密 PEM 私钥。启动前读取并验证；缺一、不可读、无效或不匹配均中止启动。未配置两项时保持 HTTP/WS。TLS 握手使用 `ws_handshake_timeout_secs` 限时，停机会取消未完成的 TLS 握手并按现有机制关闭 WSS。TLS 配置独立于 SIGHUP/管理端配置热重载；更新证书、私钥或 TLS 环境变量后重启进程，其他已有热重载项保持原有行为。

## 4. Vite 开发：前端 HTTPS，后端 HTTP

分别开两个终端。证书环境变量只放在**前端命令前缀**，不要全局 export 给两端；默认 Vite 代理通过 HTTP/WS 访问后端。

终端 A（清除继承的 TLS 变量，启动 HTTP 后端）：

```bash
env -u TLS_CERT_FILE -u TLS_KEY_FILE pnpm dev:server
```

终端 B（Vite HTTPS，允许局域网访问）：

```bash
TLS_CERT_FILE=.certs/lan-cert.pem TLS_KEY_FILE=.certs/lan-key.pem pnpm dev --host 0.0.0.0
```

手机访问 `https://192.168.1.100:5173/lobby`，并放行 TCP 5173。浏览器的 WSS `/signal`、HTTPS `/config`、HTTPS `/healthz` 由 Vite 代理到本机 3000 端口；浏览器不会直接访问明文后端。PowerShell 可在终端 A 删除对应 `Env:` 变量，在终端 B 按上一节设置变量后运行 `pnpm dev --host 0.0.0.0`。

## 5. 公网生产：域名 + Caddy TLS 终止

面向普通用户使用公网域名与公共 CA 证书，避免要求用户安装开发根证书。仓库提供 [deploy/Caddyfile](../deploy/Caddyfile)：同一域名代理网页、配置及 WebSocket，同时拒绝公网访问 `/admin` 与 `/metrics`。Caddy 的 `reverse_proxy` 自动处理 WebSocket Upgrade。[代理说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

1. 安装 Caddy，将自己的域名 A/AAAA 记录指向服务器，放行公网 TCP 80/443，确保 Caddy 可绑定这些端口，保留其数据目录以续签证书。
2. 将后端绑定到回环地址，仅允许代理访问。Node 运行 `HOST=127.0.0.1 PORT=3000 pnpm start`，并清除直接 TLS 变量；Rust 配置 `GOMOKU_HOST=127.0.0.1 GOMOKU_PORT=3000` 后按 [Rust 运行说明](../apps/signaling-rust/README.md)启动。
3. 从仓库根运行：

   ```bash
   GOMOKU_DOMAIN=gomoku.example.com caddy run --config deploy/Caddyfile
   ```

   将示例域名替换成你自己的真实域名。满足 DNS/端口条件后，Caddy 获取并续签公共证书，HTTP 自动跳转 HTTPS。[自动 HTTPS 条件](https://caddyserver.com/docs/automatic-https)

客户端直接访问 `https://你的域名/lobby`，自动使用 `wss://你的域名/signal`，无需改前端配置。Rust 如配置 Origin 白名单，应加入完整的 `https://你的域名`；只有在后端回环绑定、防火墙隔离并确认所有请求都来自可信代理时，才启用 `GOMOKU_TRUST_PROXY_HEADERS=true` 获取真实客户端 IP。Node 参考服务按 socket IP 限制连接数，反代后多用户共享代理 IP 的 10 连接配额，面向多用户部署优先使用 Rust。

该示例负责应用 HTTPS，P2P 直连仍受 NAT/防火墙影响；跨网络连接失败时参考 [TURN 排障](turn-relay-recovery.md)。服务与 TLS 证书的部署、系统信任修改均由部署者按自己的环境执行。

## 6. 语音权限与排障

双方均打开受信任 HTTPS 页面并刷新到新版本，完成连接后切到“聊天”，点击“语音消息”，允许麦克风权限，录制后发送。只要一方仍是局域网 HTTP 页面，对方就可能提示其不支持语音。

| 现象 | 检查与处理 |
|---|---|
| 提示“请使用 HTTPS” | 地址栏是否仍为局域网 HTTP；改用证书覆盖的 HTTPS 地址 |
| HTTPS 仍不安全/证书警告 | 各设备是否安装同一 CA、iOS 是否完全信任、SAN 是否覆盖当前 IP、证书是否过期 |
| “对方不支持语音” | 对方也须受信任 HTTPS，并使用支持 MediaRecorder 的浏览器；两端都刷新 |
| 麦克风被拒绝 | 在浏览器站点设置重置麦克风权限，同时检查系统对浏览器的麦克风权限；HTTPS 不会绕过权限 |
| 页面可开，大厅断线 | 网络面板检查 `/signal` 是否为 WSS 和状态 101；确认代理保留 Upgrade、Origin 白名单正确、两端后端协议一致 |
| Vite 代理报错 | 后端是否仍在 HTTP 3000；TLS 变量只应设置给前端命令 |
| `ERR_SSL_PROTOCOL_ERROR` | 是否把 HTTPS 地址连到了 HTTP 端口，或把 HTTP 地址连到 HTTPS 端口 |
| 手机打不开 | 检查局域网 IP、端口、防火墙、AP 隔离与 VPN；手机上的 localhost 指手机自身 |

开发者可检查 `window.isSecureContext === true` 且 `typeof navigator.mediaDevices?.getUserMedia === 'function'`。仍需实际授权麦克风，并确认对端成功接收到语音。

## 7. 验证命令与边界

```bash
pnpm build && pnpm test
pnpm test:https
# Rust 原生 TLS：先构建 Rust 二进制，再复用真实语音验收：
cargo build --manifest-path apps/signaling-rust/Cargo.toml
HTTPS_SERVER=rust node test/https.e2e.js
# 启动单独的 HTTP Node 服务后跑完整回归：
pnpm test:e2e
```

`pnpm test:https` 需要 OpenSSL 和测试用 Chromium（与现有 E2E 一致）。脚本临时生成仅一天有效的证书，启动独立 HTTPS 服务，显式信任该临时证书校验 HTTPS 与 WSS，再通过独立浏览器上下文验证 HTTPS 下真实 WebRTC 连接、MediaRecorder 录制、语音传输与换房隔离。浏览器上下文为测试显式忽略临时证书错误，**不等同于真实手机已信任证书**；设备信任与真实麦克风授权仍需按上文配置。临时证书在测试结束删除，不安装到系统信任库。
