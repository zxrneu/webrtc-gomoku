# TURN 中继配置与验收

WebRTC 直连受 NAT、防火墙和网络策略影响。需要中继时，可在自己的服务器部署 coturn，通过信令服务的 `/config` 下发 ICE 配置；信令与 TURN 分别提供连接协商和数据中继。

## 部署

1. 安装 coturn，备份当前配置。应用路径从 `gomoku-signaling.service` 的 `WorkingDirectory` 确认，管理方式见[阿里云运维](aliyun-operations.md)。
2. 在服务器生成随机 TURN 密码，保存在权限受限的配置中。不要写入仓库或日志。
3. 按下方示例配置 coturn，并在云安全组与主机防火墙放行 TCP / UDP 7001、UDP 7002–7101；使用其他端口时同步修改配置与规则。
4. 配置信令服务的 ICE 参数，通过 SIGHUP 热加载 Rust 配置，并在 `/config` 检查下发结果。
5. 重建测试房间，按下方命令验收真实 P2P 与强制中继连接。

## coturn 配置示例

将 `<PUBLIC_IP>` 和 `<PRIVATE_IP>` 替换为本机公网、内网地址；`<TURN_KEY>` 为 `MD5("gomoku:gomoku:" + 随机密码)` 的十六进制值。

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

示例限制为 100 个分配，每个分配 128 KiB/s。中继会消耗服务器流量，配额应按实际出口预算调整；内网和云元数据地址限制应保留。

## Rust 信令配置

```toml
[ice]
stun_servers = ["stun:<PUBLIC_IP>:7001"]
turn_url = "turn:<PUBLIC_IP>:7001?transport=tcp"
turn_username = "gomoku"
turn_credential = "<运行时生成的随机密码>"
turn_credential_exposed = true
```

`turn_credential_exposed` 表示允许将 TURN 凭证下发给浏览器；不要复用系统登录密码。服务的 HTTPS 配置见 [HTTPS 与语音](https.md)。

## 验收与排障

将 `GOMOKU_BASE_URL` 设置为部署地址，再从仓库根目录执行：

```sh
# 要求真实 DataChannel，连接失败时退出非零
BASE="${GOMOKU_BASE_URL:?请先设置部署地址}" REQUIRE_P2P=1 pnpm test:e2e

# 仅允许中继候选，并检查选中的候选对为 relay
BASE="${GOMOKU_BASE_URL:?请先设置部署地址}" REQUIRE_RELAY=1 pnpm test:e2e

# 断线恢复与棋谱同步
BASE="${GOMOKU_BASE_URL:?请先设置部署地址}" node test/reconnect-regression-e2e.js
```

信令 `/healthz` 正常不代表 DataChannel 已连接。检查 `/config` 是否包含 TURN、浏览器是否生成 relay 候选、所选候选对类型，以及真实落子和聊天能否同步。未配置可用 TURN 时，强制中继验收应失败；协议仿真不能替代生产连通性验收。

回滚时恢复已备份的 coturn 与信令配置，重载对应服务并重新验收。配置项参考 [coturn 官方示例](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)。
