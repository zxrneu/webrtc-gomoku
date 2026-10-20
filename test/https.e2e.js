'use strict';
// 临时证书只存于系统临时目录；不安装 CA、不修改系统信任库。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('../apps/server/node_modules/ws');

const root = path.resolve(__dirname, '..');
const rustServer = process.env.HTTPS_SERVER === 'rust';
const targetDir = path.resolve(root, process.env.CARGO_TARGET_DIR || 'apps/signaling-rust/target');
const rustBinary = path.resolve(root, process.env.RUST_SERVER_BIN || path.join(targetDir, 'debug', process.platform === 'win32' ? 'gomoku-signaling.exe' : 'gomoku-signaling'));
const port = Number(process.env.HTTPS_TEST_PORT || 3106);
const base = `https://127.0.0.1:${port}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gomoku-https-'));
let server;
let serverError;

function request(route, ca) {
  return new Promise((resolve, reject) => {
    https.get(base + route, { ca }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).setTimeout(1000, function () { this.destroy(new Error('HTTPS request timed out')); });
  });
}

async function waitForServer(ca) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error('HTTPS server exited before becoming ready (Rust 模式请先 cargo build)');
    try { return await request('/healthz', ca); }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('HTTPS server readiness timed out');
}

(async () => {
  const certFile = path.join(temp, 'cert.pem');
  const keyFile = path.join(temp, 'key.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, `openssl certificate generation failed: ${generated.stderr}`);
  const ca = fs.readFileSync(certFile);
  server = spawn(rustServer ? rustBinary : process.execPath, rustServer ? [] : ['apps/server/dist/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
      GOMOKU_PORT: String(port), GOMOKU_HOST: '127.0.0.1', GOMOKU_REDIS_ENABLED: 'false',
      GOMOKU_PUBLIC_DIR: 'packages/web/dist',
      TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.once('error', error => { serverError = error; });
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  assert.equal((await waitForServer(ca)).status, 200);
  await assert.rejects(request('/healthz'), /self-signed|certificate/i, '未配置 CA 时应拒绝临时证书');
  assert.match(logs, /https:\/\//);
  assert.match(logs, /wss:\/\//);
  assert.equal((await request('/', ca)).status, 200);
  assert.equal(JSON.parse((await request('/config', ca)).body).capabilities.lobby, true);
  const socket = new WebSocket(`${base.replace('https:', 'wss:')}/signal`, { ca, handshakeTimeout: 5000 });
  await once(socket, 'open');
  const message = once(socket, 'message');
  socket.send(JSON.stringify({ t: 'ping', ts: 42 }));
  assert.deepEqual(JSON.parse(String((await message)[0])), { t: 'pong', ts: 42 });
  socket.close();
  await once(socket, 'close');
  console.log(`ok - ${rustServer ? 'Rust' : 'Node'} HTTPS 静态网页、配置、健康检查及 WSS 均通过显式 CA 校验`);

  // 浏览器仅在独立测试上下文忽略临时证书错误；不代表手机已信任此 CA。
  const media = spawn(process.execPath, ['test/media-real-p2p.e2e.js'], {
    cwd: root,
    env: { ...process.env, MEDIA_BASE: base, TLS_CA_FILE: certFile, E2E_IGNORE_HTTPS_ERRORS: '1' },
    stdio: 'inherit',
  });
  const [code] = await once(media, 'exit');
  assert.equal(code, 0, 'HTTPS 真实 P2P 语音验收失败');
  console.log('ok - HTTPS 双端 WSS 建连、录音、语音传输及换房隔离通过');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server?.pid && server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
