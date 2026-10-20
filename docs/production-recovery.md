# 公网部署、迁移与恢复

本文提供 Linux x86_64、systemd、Rust 原生 HTTPS 的完整重建路径。只部署网页、信令与证书续签；跨网络中继另见 [TURN 配置](turn.md)。现有实例的日常命令见[阿里云运维](aliyun-operations.md)。本地 mkcert 不用于公网证书。

模板位于 [deploy/production](../deploy/production/)。它们不会自行安装或修改服务；按下文复制后才生效。服务器地址、应用目录、服务账号、代理与证书材料均由部署环境提供，不写入仓库。

## 1. 构建与打包

以下在 Linux x86_64 构建机的仓库根目录执行，需要 Node、pnpm、Rust、GNU coreutils、tar 和 musl 工具链。Debian / Ubuntu 可安装 `musl-tools` 提供 `musl-gcc`。macOS 原生 Cargo 产物不能直接部署到 Linux；可用独立 Linux 构建机，或按 [Rust 构建说明](../apps/signaling-rust/README.md#4-手动构建各平台二进制免-docker)配置交叉编译。

```sh
set -euo pipefail
pnpm install --frozen-lockfile
pnpm build
pnpm test
rustup target add x86_64-unknown-linux-musl
CARGO_TARGET_DIR=output/rust-linux cargo build --locked --release \
  --manifest-path apps/signaling-rust/Cargo.toml --target x86_64-unknown-linux-musl

GOMOKU_RELEASE=output/releases/$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)
test ! -e "$GOMOKU_RELEASE"
mkdir -p "$GOMOKU_RELEASE/public" "$GOMOKU_RELEASE/ops"
install -m 755 output/rust-linux/x86_64-unknown-linux-musl/release/gomoku-signaling \
  "$GOMOKU_RELEASE/gomoku-signaling"
install -m 644 packages/web/dist/index.html "$GOMOKU_RELEASE/public/index.html"
install -m 644 dist/gomoku-standalone.html "$GOMOKU_RELEASE/public/gomoku-standalone.html"
cp deploy/production/* "$GOMOKU_RELEASE/ops/"
cp apps/signaling-rust/config.example.toml "$GOMOKU_RELEASE/config.example.toml"
printf 'commit=%s\ntarget=%s\nbuilt_at=%s\n' "$(git rev-parse HEAD)" \
  x86_64-unknown-linux-musl "$(date -u +%FT%TZ)" > "$GOMOKU_RELEASE/RELEASE"
(
  cd "$GOMOKU_RELEASE"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)
tar -C "$GOMOKU_RELEASE" -czf "$GOMOKU_RELEASE.tar.gz" .
```

构建发布包前提交或明确记录本地代码变更，避免 `RELEASE` 中的提交号无法解释实际产物。包中只有程序、静态页、公开配置示例和运维模板，不包含现有 `config.toml`、私钥、账号资料或私有地址文件。

通过自己的 SSH 通道上传包，在服务器独立暂存目录解压，并在解压目录执行 `sha256sum -c SHA256SUMS`；检查全部通过后再安装。不要把发布包直接解压覆盖正在运行的应用目录。

## 2. 新服务器的环境与目录

以下以 root 在同一 Bash 会话运行。服务器需要 Bash、curl、OpenSSL、Python 3、GNU coreutils、util-linux（含 flock）、tar、系统 CA 与 systemd。HTTP-01 要求公网 TCP 80 可达且验证时无人占用；游戏使用 TCP 443。按自己的云安全组和主机防火墙放行，不需要把应用的回环测试端口暴露到公网。

先交互输入路径，避免把某台机器的安装目录固化在模板中：

```sh
set -euo pipefail
read -r -p '已解压并校验的发布目录（绝对路径）: ' GOMOKU_RELEASE_DIR
read -r -p '应用安装目录（绝对路径）: ' GOMOKU_APP_DIR
read -r -p '证书工具与账号目录（独立的绝对路径）: ' GOMOKU_ACME_DIR
read -r -p 'systemd 自定义系统单元目录（绝对路径）: ' GOMOKU_UNIT_DIR
read -r -p '服务器公网 IPv4: ' GOMOKU_PUBLIC_IP
GOMOKU_APP_USER=gomoku
export GOMOKU_RELEASE_DIR GOMOKU_APP_DIR GOMOKU_ACME_DIR GOMOKU_UNIT_DIR GOMOKU_APP_USER GOMOKU_PUBLIC_IP
python3 - <<'PY'
import ipaddress, os, pathlib
ipaddress.IPv4Address(os.environ['GOMOKU_PUBLIC_IP'])
for key in ['GOMOKU_RELEASE_DIR', 'GOMOKU_APP_DIR', 'GOMOKU_ACME_DIR', 'GOMOKU_UNIT_DIR']:
    value = os.environ[key]
    assert pathlib.Path(value).is_absolute(), key + ' 必须为绝对路径'
    assert not any(char in value for char in '\n\r%"\\'), key + ' 含不支持的字符'
assert os.environ['GOMOKU_APP_DIR'] != os.environ['GOMOKU_ACME_DIR'], '应用与账号目录必须分开'
PY
id "$GOMOKU_APP_USER" >/dev/null 2>&1 || \
  useradd --system --no-create-home --shell "$(command -v nologin)" "$GOMOKU_APP_USER"
GOMOKU_APP_GROUP=$(id -gn "$GOMOKU_APP_USER")
install -d -m 750 -o "$GOMOKU_APP_USER" -g "$GOMOKU_APP_GROUP" "$GOMOKU_APP_DIR"
install -d -m 700 "$GOMOKU_ACME_DIR"
install -d -m 755 "$GOMOKU_UNIT_DIR"
```

新服务器安装程序、页面和配置。**已有实例升级时跳过本段配置初始化**，按第 6 节保留原配置。

```sh
test ! -e "$GOMOKU_APP_DIR/config.toml"
install -m 755 -o "$GOMOKU_APP_USER" -g "$GOMOKU_APP_GROUP" \
  "$GOMOKU_RELEASE_DIR/gomoku-signaling" "$GOMOKU_APP_DIR/gomoku-signaling"
cp -a "$GOMOKU_RELEASE_DIR/public" "$GOMOKU_APP_DIR/public"
chown -R "$GOMOKU_APP_USER:$GOMOKU_APP_GROUP" "$GOMOKU_APP_DIR/public"
install -m 600 -o "$GOMOKU_APP_USER" -g "$GOMOKU_APP_GROUP" \
  "$GOMOKU_RELEASE_DIR/config.example.toml" "$GOMOKU_APP_DIR/config.toml"
install -m 644 "$GOMOKU_RELEASE_DIR/RELEASE" "$GOMOKU_APP_DIR/RELEASE"
```

模板默认关闭 Redis，适合单节点；已有集群要调整服务环境变量。按实际需求编辑 `config.toml` 中的 Origin、ICE/TURN 和限额，保留配置权限。TURN 凭据与管理令牌不写入示例。程序管理端令牌为空时保持禁用。

## 3. 安装服务与证书工具

渲染三个服务模板；这个步骤只写入单元，不启动游戏。安装脚本会通过 systemd 读取应用目录与服务账号。

```sh
python3 - <<'PY'
import os, pathlib
source = pathlib.Path(os.environ['GOMOKU_RELEASE_DIR']) / 'ops'
dest = pathlib.Path(os.environ['GOMOKU_UNIT_DIR'])
values = {'@APP_DIR@': os.environ['GOMOKU_APP_DIR'], '@APP_USER@': os.environ['GOMOKU_APP_USER'],
          '@ACME_DIR@': os.environ['GOMOKU_ACME_DIR']}
for name in ['gomoku-signaling.service.in', 'gomoku-https-renew.service.in']:
    text = (source / name).read_text()
    for token, value in values.items():
        text = text.replace(token, value)
    target = dest / name.removesuffix('.in')
    target.write_text(text)
    target.chmod(0o644)
target = dest / 'gomoku-https-renew.timer'
target.write_bytes((source / target.name).read_bytes())
target.chmod(0o644)
PY
systemctl daemon-reload
install -m 700 "$GOMOKU_RELEASE_DIR/ops/renew.example" "$GOMOKU_ACME_DIR/renew"
install -m 700 "$GOMOKU_RELEASE_DIR/ops/install-certificate.example" "$GOMOKU_ACME_DIR/install-certificate"
install -m 600 "$GOMOKU_RELEASE_DIR/ops/acme.env.example" "$GOMOKU_ACME_DIR/acme.env"
printf '%s\n' "$GOMOKU_PUBLIC_IP" > "$GOMOKU_ACME_DIR/ip"
chmod 600 "$GOMOKU_ACME_DIR/ip"
```

直接下载与现有流程匹配的 [LEGO v5.5.2](https://github.com/go-acme/lego/releases/tag/v5.5.2)，核对官方 SHA256；以下资产仅用于 Linux amd64。

```sh
GOMOKU_LEGO_URL=https://github.com/go-acme/lego/releases/download/v5.5.2
GOMOKU_LEGO_ASSET=lego_v5.5.2_linux_amd64.tar.gz
mkdir -p "$GOMOKU_ACME_DIR/download"
(
  cd "$GOMOKU_ACME_DIR/download"
  curl -fL --retry 3 "$GOMOKU_LEGO_URL/$GOMOKU_LEGO_ASSET" -o "$GOMOKU_LEGO_ASSET"
  curl -fL --retry 3 "$GOMOKU_LEGO_URL/lego_5.5.2_checksums.txt" -o checksums.txt
  awk -v asset="$GOMOKU_LEGO_ASSET" '$2 == asset {print}' checksums.txt > selected-checksum.txt
  sha256sum -c selected-checksum.txt
  tar -xzf "$GOMOKU_LEGO_ASSET" lego
  install -m 700 lego "$GOMOKU_ACME_DIR/lego"
)
"$GOMOKU_ACME_DIR/lego" --version
```

需要出站代理时，在 root 可读的 `acme.env` 中设置 `GOMOKU_ACME_PROXY`。模板不依赖 Mihomo；已有代理可复用，首次签发前也要给当前 shell 设置代理。不要把含代理凭据的配置提交到 Git。

## 4. 首次证书与自动续签

只在首次部署或无法恢复有效证书时签发；迁移已有账号时优先恢复第 7 节的私有备份。先在 staging 验证 HTTP-01，再签正式证书。LEGO v5 的 `run` 统一处理首次签发和后续续签，参数位置与旧版不同。

```sh
# 如果使用代理，给首次签发和下载所在 shell 设置同一代理
source "$GOMOKU_ACME_DIR/acme.env"
if test -n "${GOMOKU_ACME_PROXY:-}"; then
  export HTTPS_PROXY="$GOMOKU_ACME_PROXY" HTTP_PROXY="$GOMOKU_ACME_PROXY"
fi
export NO_PROXY="127.0.0.1,localhost,$GOMOKU_PUBLIC_IP"
umask 077
"$GOMOKU_ACME_DIR/lego" run --server letsencrypt-staging \
  --path "$GOMOKU_ACME_DIR/staging" --account-id gomoku-ip \
  --http --domains "$GOMOKU_PUBLIC_IP" --profile shortlived --accept-tos --no-random-sleep

"$GOMOKU_ACME_DIR/lego" run --server letsencrypt \
  --path "$GOMOKU_ACME_DIR/production" --account-id gomoku-ip \
  --http --domains "$GOMOKU_PUBLIC_IP" --profile shortlived --accept-tos --no-random-sleep

"$GOMOKU_ACME_DIR/install-certificate" --install-only
systemctl enable --now gomoku-signaling.service
curl --noproxy '*' --resolve "$GOMOKU_PUBLIC_IP:443:127.0.0.1" \
  -fsS "https://$GOMOKU_PUBLIC_IP/healthz"
systemctl enable --now gomoku-https-renew.timer
systemctl list-timers gomoku-https-renew.timer --all --no-pager
```

staging 证书不受普通浏览器信任，不安装到应用。正式 IP 证书使用 `shortlived` 配置，有效期约 160 小时，需要自动续签，见 [Let’s Encrypt 说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)。模板按**服务器时区**每天 00、06、12、18 点检查，最多随机延迟 15 分钟；用 `timedatectl` 查看当前时区。

续签脚本使用私有目录中的锁防止并发，未到续签时间不会重启游戏。取得新证书后，安装脚本验证 IP、至少剩余一小时、公私钥匹配，再切换 `.certs/current`。重启或可信 HTTPS 检查失败时尝试恢复前一证书并返回失败；此时查看 service 日志，不要只看旧服务是否重新启动。

## 5. 上线验证

```sh
systemctl status gomoku-signaling.service gomoku-https-renew.timer --no-pager
systemctl show gomoku-https-renew.service -p Result -p ExecMainStatus
journalctl -u gomoku-signaling -n 50 --no-pager
openssl x509 -in "$GOMOKU_APP_DIR/.certs/current/fullchain.pem" -noout -dates -ext subjectAltName
```

再从其他设备打开公网 HTTPS：确认无证书警告、能进入大厅、双方邀请入座并真实落子、发送图片和语音，刷新后恢复棋谱。只有 `/healthz` 成功不足以验收。浏览器自动化和强制 TURN 检查见[测试说明](testing.md)；不要用 `curl -k` 作为证书信任通过的依据。

## 6. 升级与应用回滚

上传新包后先在独立目录校验 SHA256，并用回环地址、独立端口和原配置验证候选程序。正常实例保持原来的 `.certs/`、`config.toml`、证书工具目录与 systemd 配置。

在服务器同一 shell 中，`GOMOKU_RELEASE_DIR` 指向已验证的新包，其他变量仍指当前安装位置：

```sh
GOMOKU_BACKUP_DIR="$GOMOKU_APP_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$GOMOKU_BACKUP_DIR"
cp -a "$GOMOKU_APP_DIR/gomoku-signaling" "$GOMOKU_APP_DIR/public" \
  "$GOMOKU_APP_DIR/config.toml" "$GOMOKU_APP_DIR/RELEASE" "$GOMOKU_BACKUP_DIR/"

# 暂停服务后成组替换；期间会短暂中断连接
systemctl stop gomoku-signaling
install -m 755 -o "$GOMOKU_APP_USER" -g "$GOMOKU_APP_GROUP" \
  "$GOMOKU_RELEASE_DIR/gomoku-signaling" "$GOMOKU_APP_DIR/gomoku-signaling"
mv "$GOMOKU_APP_DIR/public" "$GOMOKU_BACKUP_DIR/public-before-switch"
cp -a "$GOMOKU_RELEASE_DIR/public" "$GOMOKU_APP_DIR/public"
chown -R "$GOMOKU_APP_USER:$GOMOKU_APP_GROUP" "$GOMOKU_APP_DIR/public"
install -m 644 "$GOMOKU_RELEASE_DIR/RELEASE" "$GOMOKU_APP_DIR/RELEASE"
systemctl start gomoku-signaling
curl --noproxy '*' --resolve "$GOMOKU_PUBLIC_IP:443:127.0.0.1" \
  -fsS --retry 12 --retry-connrefused --retry-delay 1 "https://$GOMOKU_PUBLIC_IP/healthz"
```

任一步失败都停止后续发布并执行回滚。确认 `GOMOKU_BACKUP_DIR` 指向要恢复的版本，成组恢复程序、前端与版本文件；若同时改过配置，再恢复匹配配置。下面只适用于同一套 HTTPS 配置下的应用回滚：

```sh
systemctl stop gomoku-signaling
install -m 755 -o "$GOMOKU_APP_USER" -g "$GOMOKU_APP_GROUP" \
  "$GOMOKU_BACKUP_DIR/gomoku-signaling" "$GOMOKU_APP_DIR/gomoku-signaling"
if test -e "$GOMOKU_APP_DIR/public"; then
  mv "$GOMOKU_APP_DIR/public" "$GOMOKU_BACKUP_DIR/public-failed-$(date -u +%Y%m%dT%H%M%SZ)"
fi
cp -a "$GOMOKU_BACKUP_DIR/public" "$GOMOKU_APP_DIR/public"
cp -a "$GOMOKU_BACKUP_DIR/RELEASE" "$GOMOKU_APP_DIR/RELEASE"
systemctl start gomoku-signaling
curl --noproxy '*' --resolve "$GOMOKU_PUBLIC_IP:443:127.0.0.1" \
  -fsS --retry 12 --retry-connrefused --retry-delay 1 "https://$GOMOKU_PUBLIC_IP/healthz"
```

证书回滚单独处理：检查上一证书仍有效、IP 与密钥匹配，恢复 `.certs/current` 链接后重启。回退到不支持 HTTPS 的旧程序时，还需要配套恢复监听/TLS 配置；不能直接套用上面的 HTTPS 健康检查。

## 7. 迁移与私有备份

应用状态主要在内存中，迁移会丢失在线大厅与活动房间。保存程序和 `RELEASE`、前端、`config.toml`、应用 `.certs/`、整个证书工具目录（含 ACME 账号、续签脚本、IP 和代理配置）、systemd 单元及所有 drop-in；使用 TURN 时另保存 coturn 配置。

备份可能含私钥、代理和 TURN 凭据，应加密离机保存，不能放到 Git 或静态托管目录。恢复后保持服务用户、文件权限和目录引用一致；路径改变时重新渲染单元或修正既有 drop-in，不能只复制一个二进制。若公网 IP 改变，需要为新 IP 签发证书，不能继续使用旧 IP 的证书。

仓库中的模板用于重建，**不会同步修改现网单元**。现有实例可能采用 HTTPS drop-in，而模板将 TLS 设置写入主单元；合并时检查 `systemctl cat gomoku-signaling`，防止旧 drop-in 覆盖新配置。新服务器无出站代理时可直连 ACME；代理实例不是游戏服务本身。
