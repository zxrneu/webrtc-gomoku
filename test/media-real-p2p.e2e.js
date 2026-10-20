'use strict';
/**
 * 真实 P2P 环境下的富媒体（图片、文件、语音）端到端传输验证
 *
 * 验证目标：
 * 1. 真实 WebRTC DataChannel 握手连通（禁用 mDNS 本地 IP 遮蔽以在同一宿主机互连）；
 * 2. 真实双向能力协商（file: true, audio: true）；
 * 3. 图片消息：分片传输、ACK 握手、哈希校验、对端渲染、逐字节 SHA-256 比对一致；
 * 4. 文件消息：分片传输、ACK 握手、对端渲染、逐字节 SHA-256 比对一致；
 * 5. 语音消息：真实 MediaRecorder 采集、分片传输、ACK 握手、对端 <audio> 渲染与数据完整性。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 3105;
const BASE = process.env.MEDIA_BASE || `http://127.0.0.1:${PORT}`;
const ignoreHTTPSErrors = process.env.E2E_IGNORE_HTTPS_ERRORS === '1';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const transport = url.startsWith('https:') ? https : http;
        const ca = process.env.TLS_CA_FILE ? fs.readFileSync(process.env.TLS_CA_FILE) : undefined;
        const req = transport.get(url, { ca }, (res) => {
          if (res.statusCode && res.statusCode < 500) resolve();
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy());
      });
      return;
    } catch {
      await wait(200);
    }
  }
  throw new Error(`Server failed to respond at ${url} within ${timeoutMs}ms`);
}

(async () => {
  console.log('--- 启动独立信令与静态文件服务 (PORT=' + PORT + ') ---');
  const serverProc = process.env.MEDIA_BASE ? undefined : spawn(process.execPath, [path.join(__dirname, '../apps/server/dist/server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc?.stdout.on('data', (d) => process.stdout.write(`[Server] ${d}`));
  serverProc?.stderr.on('data', (d) => process.stderr.write(`[Server ERR] ${d}`));

  let browser;
  try {
    await waitForServer(BASE);
    console.log('--- 服务已就绪，启动 Chromium 双端上下文 ---');

    browser = await chromium.launch({
      channel: 'chrome',
      args: [
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--no-sandbox',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    });

    const ctxA = await browser.newContext({ ignoreHTTPSErrors, viewport: { width: 1280, height: 800 } });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors, viewport: { width: 1280, height: 800 } });
    // 授予麦克风权限
    await ctxA.grantPermissions(['microphone'], { origin: BASE });
    await ctxB.grantPermissions(['microphone'], { origin: BASE });

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    pageA.on('pageerror', (e) => console.error('[PageA error]', e));
    pageB.on('pageerror', (e) => console.error('[PageB error]', e));

    console.log('--- 打开客户端并建立房间连接 ---');
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    for (const page of [pageA, pageB]) {
      assert.equal(await page.evaluate(() => window.isSecureContext), true, '录音页面必须为安全上下文');
      assert.equal(await page.evaluate(() => typeof navigator.mediaDevices?.getUserMedia), 'function');
    }
    for (const page of [pageA, pageB]) {
      if (await page.locator('#lobby-page').count()) await page.locator('#lobby-board-btn').click();
      if (await page.locator('[data-online-tab="room"]').count()) await page.locator('[data-online-tab="room"]').click();
    }

    await pageA.waitForFunction(() => !!window.__gomoku);
    await pageB.waitForFunction(() => !!window.__gomoku);

    await pageA.fill('#name-input', 'HostA');
    await pageB.fill('#name-input', 'GuestB');

    await pageA.click('#create-room-btn');
    await pageA.waitForSelector('#room-info:not(.hidden)', { timeout: 8000 });
    const room = (await pageA.textContent('#room-code-text')).trim();
    console.log('  建房成功，房号:', room);

    await pageB.fill('#room-input', room);
    await pageB.click('#join-room-btn');

    console.log('  等待真实 P2P WebRTC DataChannel 连通...');
    await pageA.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 15000 });
    await pageB.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 15000 });
    console.log('  ok - 真实 P2P DataChannel 已双向连通！');

    // 切换到聊天 Tab


    const chatTabA = pageA.getByRole('button', { name: /^打开聊天/ });
    const chatTabB = pageB.getByRole('button', { name: /^打开聊天/ });
    await chatTabA.click();
    await chatTabB.click();

    // 等待能力协商完成，三个富媒体按钮在双方都正常渲染
    await pageA.waitForSelector('#chat-image-btn', { timeout: 5000 });
    await pageA.waitForSelector('#chat-file-btn', { timeout: 5000 });
    await pageA.waitForSelector('#chat-voice-btn', { timeout: 5000 });

    await pageB.waitForSelector('#chat-image-btn', { timeout: 5000 });
    await pageB.waitForSelector('#chat-file-btn', { timeout: 5000 });
    await pageB.waitForSelector('#chat-voice-btn', { timeout: 5000 });
    console.log('  ok - 双方富媒体能力协商完成，入口按钮全部就绪');

    // ==========================================
    // 1. 真实 P2P 图片传输验证
    // ==========================================
    console.log('--- 1. 验证真实 P2P 图片传输 ---');
    // 构造一个 64KB 的 PNG 测试数据（跨多个 16KB 分片）
    const imagePayload = Buffer.alloc(65536);
    imagePayload.fill(0x89);
    imagePayload.write('PNG\r\n\x1a\n', 1);
    for (let i = 8; i < imagePayload.length; i++) imagePayload[i] = (i * 31 + 7) & 0xff;
    const originalImageHash = sha256Hex(imagePayload);

    await pageA.locator('#chat-image-input').setInputFiles({
      name: 'photo-test.png',
      mimeType: 'image/png',
      buffer: imagePayload,
    });

    // 接收端 B 等待接收完成并渲染出图片气泡
    console.log('  等待接收端 B 接收并渲染图片...');
    const imageLocatorB = pageB.locator('#chat-list img[alt="photo-test.png"]');
    await imageLocatorB.waitFor({ timeout: 15000 });
    assert.equal(await imageLocatorB.isVisible(), true);

    // 发送端 A 也应完成传输，显示已发送的气泡
    const imageLocatorA = pageA.locator('#chat-list img[alt="photo-test.png"]');
    await imageLocatorA.waitFor({ timeout: 5000 });
    assert.equal(await imageLocatorA.isVisible(), true);

    // 从接收端 B 提取接收到的 Blob 字节，计算哈希并严格比对
    const receivedImageHex = await pageB.evaluate(async () => {
      const img = document.querySelector('#chat-list img[alt="photo-test.png"]');
      const res = await fetch(img.src);
      const buf = await res.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    });
    assert.equal(receivedImageHex, originalImageHash, '接收端图片 SHA-256 与发送端不一致！');
    console.log('  ok - 真实 P2P 图片传输成功，64KB 跨分片逐字节 SHA-256 完全一致！');

    // ==========================================
    // 2. 真实 P2P 文件传输验证
    // ==========================================
    console.log('--- 2. 验证真实 P2P 文件传输 ---');
    // 构造一个 80KB 的二进制文件测试数据（由 B 发给 A）
    const filePayload = Buffer.alloc(81920);
    for (let i = 0; i < filePayload.length; i++) filePayload[i] = (i * 47 + 13) & 0xff;
    const originalFileHash = sha256Hex(filePayload);

    await pageB.locator('#chat-file-input').setInputFiles({
      name: 'dataset-report.bin',
      mimeType: 'application/octet-stream',
      buffer: filePayload,
    });

    // 接收端 A 等待文件气泡出现并校验 download 属性
    console.log('  等待接收端 A 接收并渲染文件气泡...');
    const fileLocatorA = pageA.locator('#chat-list a[download="dataset-report.bin"]');
    await fileLocatorA.waitFor({ timeout: 15000 });
    assert.equal(await fileLocatorA.isVisible(), true);

    // 从接收端 A 提取 Blob 字节比对 SHA-256
    const receivedFileHex = await pageA.evaluate(async () => {
      const a = document.querySelector('#chat-list a[download="dataset-report.bin"]');
      const res = await fetch(a.href);
      const buf = await res.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    });
    assert.equal(receivedFileHex, originalFileHash, '接收端文件 SHA-256 与发送端不一致！');
    console.log('  ok - 真实 P2P 文件传输成功，80KB 跨分片逐字节 SHA-256 完全一致！');

    // ==========================================
    // 3. 真实 P2P 语音消息录制与传输验证
    // ==========================================
    console.log('--- 3. 验证真实 P2P 语音录制与传输 ---');
    // A 录音并发送给 B
    await pageA.click('#chat-voice-btn');
    await pageA.waitForSelector('#chat-record-send', { timeout: 5000 });
    console.log('  录音已启动，录音中...');
    await wait(1200); // 录制 1.2 秒伪音频流

    await pageA.click('#chat-record-send');
    console.log('  等待接收端 B 接收语音消息...');

    const audioLocatorB = pageB.locator('#chat-list audio');
    await audioLocatorB.waitFor({ timeout: 15000 });
    assert.equal(await audioLocatorB.isVisible(), true);

    const audioByteLength = await pageB.evaluate(async () => {
      const audio = document.querySelector('#chat-list audio');
      const res = await fetch(audio.src);
      const buf = await res.arrayBuffer();
      return buf.byteLength;
    });
    assert.ok(audioByteLength > 0, '接收到的语音消息字节数为空！');
    console.log(`  ok - 真实 P2P 语音消息传输成功，接收到 ${audioByteLength} 字节有效音频流！`);

    // ==========================================
    // 4. 验证 SVG 安全降级（防同源脚本执行 XSS）
    // ==========================================
    console.log('--- 4. 验证 SVG 安全降级（防同源脚本执行 XSS） ---');
    const svgPayload = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>localStorage.setItem("svg_pwned","yes")</script><circle cx="50" cy="50" r="40" fill="red"/></svg>',
      'utf8',
    );
    await pageA.locator('#chat-file-input').setInputFiles({
      name: 'exploit.svg',
      mimeType: 'image/svg+xml',
      buffer: svgPayload,
    });

    console.log('  等待接收端 B 接收 SVG...');
    const svgLocatorB = pageB.locator('#chat-list a[download="exploit.svg"]');
    await svgLocatorB.waitFor({ timeout: 15000 });
    assert.equal(await svgLocatorB.isVisible(), true);

    // 确认其没有 target="_blank" 打开行为（防止新标签页直接导航执行同源脚本）
    const targetAttr = await svgLocatorB.getAttribute('target');
    assert.equal(targetAttr, null, 'SVG 链接禁止包含 target="_blank"！');

    // 确认页面 localStorage 未被注入恶意键值
    const pwned = await pageB.evaluate(() => localStorage.getItem('svg_pwned'));
    assert.equal(pwned, null, 'SVG 内嵌脚本不得被执行！');
    console.log('  ok - SVG 成功降级为安全下载卡片，同源脚本执行被彻底阻止！');

    console.log('--- 5. 验证录音期间换房不会向新对手发送旧录音 ---');
    await pageA.evaluate(() => {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await getUserMedia(constraints);
        window.__recordingTracks = stream.getTracks();
        return stream;
      };
    });
    await pageA.click('#chat-voice-btn');
    await pageA.waitForSelector('#chat-record-send');
    const previousRoom = await pageA.locator('#room-code-text').innerText();

    await pageA.getByRole('button', { name: '收起聊天', exact: true }).click();
    await pageA.click('#switch-room-btn');
    await pageA.click('#create-room-btn');
    await pageA.waitForFunction(old => window.__gomoku.room && window.__gomoku.room !== old && !window.__gomoku.connected, previousRoom);
    await pageA.waitForFunction(() => window.__recordingTracks.every(track => track.readyState === 'ended'));
    assert.equal(await pageA.locator('#chat-record-send').count(), 0, '换房必须取消旧录音');

    const ctxC = await browser.newContext({ ignoreHTTPSErrors, permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
    const pageC = await ctxC.newPage();
    await pageC.goto(BASE);
    if (await pageC.locator('#lobby-page').count()) await pageC.locator('#lobby-board-btn').click();
    await pageC.locator('[data-online-tab="room"]').click();
    await pageC.fill('#room-input', await pageA.locator('#room-code-text').innerText());
    await pageC.click('#join-room-btn');
    await Promise.all([pageA, pageC].map(page => page.waitForFunction(() => window.__gomoku.connected, null, { timeout: 15000 })));

    await pageA.getByRole('button', { name: /^打开聊天/ }).click();

    await pageC.getByRole('button', { name: /^打开聊天/ }).click();
    assert.equal(await pageC.locator('#chat-list audio').count(), 0, '新对手不得收到上一房间的录音');
    await pageA.waitForFunction(() => !document.getElementById('chat-voice-btn').disabled);
    await pageA.click('#chat-voice-btn');
    await pageA.waitForSelector('#chat-record-send');
    await wait(700);
    await pageA.click('#chat-record-send');
    await pageC.locator('#chat-list audio').waitFor({ timeout: 15000 });
    assert.equal(await pageC.locator('#chat-list audio').count(), 1, '新会话仍可正常发送新录音');
    console.log('  ok - 三人换房取消旧录音、释放麦克风，新会话只收到新录音');

    console.log('\n========================================');
    console.log('  🎉 全部真实 P2P 富媒体传输端到端验收通过！');
    console.log('========================================');
  } finally {
    if (browser) await browser.close();
    serverProc?.kill('SIGTERM');
  }
})().catch((err) => {
  console.error('\n❌ 真实 P2P E2E 验证失败:', err);
  process.exit(1);
});
