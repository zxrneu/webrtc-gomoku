# 8317 联机故障与 TURN 恢复方案

## 已确认的故障（2026-10-19）

- `http://<PUBLIC_IP>:8317/healthz` 正常，建房、加入、SDP 和 ICE 消息交换成功。
- 双浏览器实际 DataChannel 未打开；本次测试网络出现 STUN DNS 错误 701，仅产生 host 候选。
- 线上 `/config` 没有 TURN，原服务器未安装 coturn，未监听 TURN 端口。
- 首次协商原本没有超时，可一直显示“正在建立直连”。本地修复为 15 秒失败提示，保留信令及手动重试入口。
- Rust 信令在目标房间校验前退出原房间，导致输错房号时删除原房间，但前端仍保留旧显示。已修复为目标准入成功后再释放旧座位；重复加入当前房间明确拒绝，保持原状态。
- 原 E2E 会在直连失败后进入协议仿真。新增严格验收开关，不允许把仿真当作真实连通。

## 实际部署

经用户授权，已安装并启用 coturn 4.18.0，使用 TCP/UDP 7001 作为入口、UDP 7002–7101 作为分配端口。已热加载 ICE 配置并原子上线 582050 字节的新页面。随后备份并更新 Rust 程序、重启信令服务，上线房间切换修复。

公网浏览器已实际获取 srflx 和 relay 候选，默认模式双方进入 CONNECTED、DataChannel 为 open；强制 relay 也已完成 11 手同步及胜负、聊天、悔棋验证。

主机 INPUT 为 ACCEPT，无需新增规则。现有公网通路已通过真实浏览器验证；服务器无可用阿里云 CLI 身份或实例 RAM 角色，因此没有读取或修改安全组规则清单。

## 部署步骤

1. 备份 `/etc/coturn/turnserver.conf`、`/home/zxr/gomoku-standalone/config.toml` 和 `public/index.html`，文件名带时间戳。
2. 在服务器生成随机 TURN 密码，不写入仓库或日志；配置文件只允许对应服务账号读取。
3. 配置并启用 coturn；只使用此服务器，不引入第三方中继。
4. 目标网络规则为允许 TCP/UDP 7001 和 UDP 7002–7101 入站；已验证当前通路可达，未重复新增规则。
5. 信令配置追加 `[ice]`，通过 SIGHUP 热加载。无需重启信令服务。
6. 原子替换已通过构建和单测的 `public/index.html`，上线首次协商超时修复。
7. Rust 全量 223 项测试通过后，交叉构建 Linux x86_64 musl 静态程序；核对上传 SHA256、备份原程序，原子替换并重启服务，检查 `/healthz`。
8. 完成下方强制中继验收，再通知用户刷新页面重建房间。

### coturn 配置

`<TURN_KEY>` 为 `MD5("gomoku:gomoku:" + 随机密码)` 的十六进制值。

```ini
listening-port=7001
listening-ip=<PRIVATE_IP>
relay-ip=<PRIVATE_IP>
external-ip=<PUBLIC_IP>/<PRIVATE_IP>
min-port=7002
max-port=7101
fingerprint
lt-cred-mech
realm=gomoku
user=gomoku:0x<TURN_KEY>
no-tls
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
user-quota=100
total-quota=100
max-bps=131072
bps-capacity=13107200
relay-threads=2
stale-nonce=600
log-file=syslog
no-software-attribute
```

上限为 100 个分配、每个分配 128 KiB/s；公网带宽会消耗该服务器流量。禁止访问上述内网及云元数据地址。

此版本默认关闭 DTLS 和 loopback peers；旧版的 `no-dtls` / `no-loopback-peers` 配置键已移除，不应写入配置。

### 信令配置

字段名按 Rust 服务实际实现使用 `stun_servers`。客户端访问 TURN 使用 TCP，优先避开本次测试网络中的 UDP/DNS 问题。

```toml
[ice]
stun_servers = ["stun:<PUBLIC_IP>:7001"]
turn_url = "turn:<PUBLIC_IP>:7001?transport=tcp"
turn_username = "gomoku"
turn_credential = "<运行时生成的随机密码>"
turn_credential_exposed = true
```

## 验收

```bash
# 必须使用真实 DataChannel，失败退出非零。
BASE=http://<PUBLIC_IP>:8317 REQUIRE_P2P=1 pnpm test:e2e

# 双方仅允许中继候选，断言选中的候选对确为 relay，再验证真实落子、聊天、悔棋等。
BASE=http://<PUBLIC_IP>:8317 REQUIRE_RELAY=1 pnpm test:e2e
```

没有 TURN 时第二条必须失败。默认 `pnpm test:e2e` 仍允许环境受限时验证协议仿真，不能用作生产连接验收。

验收中的房间保留检查通过重新加入本次测试的原房间并完成双方协商来验证，不依赖可能受其他玩家/房间过期影响的全局房间数。这个检查曾在旧 Rust 服务上真实失败；修复后必须通过。

最终结果：`pnpm build && pnpm test` 通过（53 套件、828 用例）；`cargo test --locked` 通过（223 用例）；线上 `REQUIRE_RELAY=1 pnpm test:e2e` 全部通过，含真实落子、胜负、聊天、悔棋、换边、断线恢复、错误房号保留原房间、手动邀请对局及 AI Worker/离线/降级回归。

### 上线后复查

- `BASE=http://<PUBLIC_IP>:8317 node test/reconnect-regression-e2e.js` 通过：单独关闭 DataChannel 后自动重建并保留棋谱；再次断网会锁盘；恢复后继续落子且双方棋谱一致；房主离线时有人加入，房主恢复后双方自动连接。
- 两个隔离浏览器注入 `iceTransportPolicy: 'relay'` 和空 `iceServers`，确认双方首次建连超时进入 FAILED、显示“立即重试”、没有显示已连接。恢复正常 ICE 配置并让双方点击重试后，真实 DataChannel 打开，首手棋同步成功。
- coturn 与 gomoku-signaling 均为 active、enabled。本轮覆盖的建连、失败、重试及断线恢复路径未发现新的阻断问题；不代表所有浏览器、网络和并发情况均已验证。

## 回滚

如需回滚，恢复备份的信令配置、原程序和页面，重启信令服务；停止并禁用 coturn。本次未新增安全组规则。

配置项依据 [coturn 官方配置示例](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)。
