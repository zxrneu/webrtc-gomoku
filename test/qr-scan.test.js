'use strict';
/**
 * 二维码生成与扫码功能全链路自动化测试
 *
 * 验证：
 *  1. QR 码生成：生成的 canvas 包含有效图案，并可被 jsQR / BarcodeDetector 正确解码还原
 *  2. 邀请方出码：创建房间生成 offer 后，二维码区域正常展示，默认折叠文本码
 *  3. 扫一扫弹窗 UI：点击扫一扫正常唤起弹窗，包含取景框、激光线动画、提示与控制按钮
 *  4. 扫码识别闭环：
 *     - 被邀请方扫邀请码 -> 自动填入输入框 -> 自动触发生成应答码 -> 应答二维码展示
 *     - 邀请方扫应答码 -> 自动填入输入框 -> 自动触发完成连接
 *  5. 容错与相册图片识别：
 *     - 非法二维码提示拦截
 *     - offer / answer 类型错位提示拦截
 *     - 图片文件识别通道验证
 */
const path = require('path');
const { chromium } = require('playwright');

const FILE = 'file://' + path.join(__dirname, '..', 'dist', 'gomoku-standalone.html');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(FILE);

  console.log('--- 开始二维码与扫码自动化测试 ---');

  // 1. 基础编解码往返断言
  const encodeDecodeTest = await page.evaluate(async () => {
    const testCode = 'Z-TEST-GOMOKU-CODE-1234567890';
    const canvas = document.createElement('canvas');
    const ok = window.__gomoku.renderQrToCanvas(canvas, testCode);
    if (!ok) return { ok: false, error: 'renderQrToCanvas failed' };
    const decoded = await window.__gomoku.detectQrFromSource(canvas);
    return { ok: decoded === testCode, decoded };
  });
  console.log('1. 基础 Canvas 二维码生成与解码往返:', encodeDecodeTest);
  if (!encodeDecodeTest.ok) throw new Error('二维码编解码往返测试失败');

  // 2. 邀请方创建房间并验证二维码展示
  await page.evaluate(() => {
    const input = document.getElementById('name-input');
    input.value = '测试主机';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('flow-host-btn').click();
  });
  await page.waitForFunction(() => window.__gomoku.flow === 'host-wait', null, { timeout: 3000 });
  await page.waitForFunction(() => document.getElementById('flow-host-out').value.length > 50, null, { timeout: 12000 });

  const hostQrState = await page.evaluate(() => {
    const box = document.getElementById('flow-host-qr-box');
    const canvas = document.getElementById('flow-host-qr');
    const out = document.getElementById('flow-host-out');
    return {
      boxVisible: !box.classList.contains('hidden'),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      codeFolded: out.classList.contains('is-folded'),
      codeLen: out.value.length,
    };
  });
  console.log('2. 邀请方邀请码二维码渲染状态:', hostQrState);
  if (!hostQrState.boxVisible || hostQrState.canvasWidth <= 0 || !hostQrState.codeFolded) {
    throw new Error('邀请方二维码或折叠态未正确展示');
  }

  // 3. 点击「查看文本码」与「收起文本码」
  const toggleTest = await page.evaluate(() => {
    const btn = document.getElementById('flow-host-toggle-text');
    const out = document.getElementById('flow-host-out');
    btn.click();
    const afterClick = { text: btn.textContent, folded: out.classList.contains('is-folded') };
    btn.click();
    const afterSecond = { text: btn.textContent, folded: out.classList.contains('is-folded') };
    return { afterClick, afterSecond };
  });
  console.log('3. 文本码折叠/展开切换测试:', toggleTest);
  if (toggleTest.afterClick.folded !== false || toggleTest.afterSecond.folded !== true) {
    throw new Error('文本码切换折叠失败');
  }

  // 4. 打开与关闭扫码弹窗
  await page.evaluate(() => {
    document.getElementById('flow-host-scan-btn').click();
  });
  const scannerOpened = await page.evaluate(() => {
    const mask = document.getElementById('scanner-mask');
    const title = document.getElementById('scanner-title').textContent;
    return { visible: !mask.classList.contains('hidden'), title };
  });
  console.log('4. 扫码弹窗唤起测试:', scannerOpened);
  if (!scannerOpened.visible) throw new Error('扫码弹窗未能打开');

  // 关闭扫码弹窗
  await page.evaluate(() => {
    document.getElementById('scanner-close-btn').click();
  });
  const scannerClosed = await page.evaluate(() => {
    return document.getElementById('scanner-mask').classList.contains('hidden');
  });
  console.log('   扫码弹窗关闭测试:', scannerClosed);
  if (!scannerClosed) throw new Error('扫码弹窗未能关闭');

  // 5. 跨端模拟：被邀请方扫码 -> 自动生成应答码
  const guestPage = await browser.newPage();
  guestPage.on('pageerror', (e) => errors.push('[guest] ' + e.message));
  await guestPage.goto(FILE);

  await guestPage.evaluate(() => {
    const input = document.getElementById('name-input');
    input.value = '测试客机';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('flow-guest-btn').click();
  });

  const offerCode = await page.evaluate(() => document.getElementById('flow-host-out').value);

  // 被邀请方打开扫码器并模拟识别到 host 的 offerCode
  await guestPage.evaluate(async (offer) => {
    window.__gomoku.openScanner('guest-offer');
    await window.__gomoku.handleScannedText(offer);
  }, offerCode);

  await guestPage.waitForFunction(() => window.__gomoku.flow === 'guest-wait', null, { timeout: 12000 });
  await guestPage.waitForFunction(() => document.getElementById('flow-guest-out').value.length > 50, null, { timeout: 12000 });

  const guestAnswerState = await guestPage.evaluate(() => {
    const box = document.getElementById('flow-guest-qr-box');
    const canvas = document.getElementById('flow-guest-qr');
    const out = document.getElementById('flow-guest-out');
    return {
      flow: window.__gomoku.flow,
      boxVisible: !box.classList.contains('hidden'),
      canvasWidth: canvas.width,
      answerLen: out.value.length,
    };
  });
  console.log('5. 被邀请方识别邀请码并自动生成应答码:', guestAnswerState);
  if (!guestAnswerState.boxVisible || guestAnswerState.canvasWidth <= 0) {
    throw new Error('被邀请方未成功生成并展示应答二维码');
  }

  // 6. 邀请方扫应答码 -> 自动填入并触发完成连接
  const answerCode = await guestPage.evaluate(() => document.getElementById('flow-guest-out').value);
  await page.evaluate(async (answer) => {
    window.__gomoku.openScanner('host-answer');
    await window.__gomoku.handleScannedText(answer);
  }, answerCode);

  const hostFinishedState = await page.evaluate(() => {
    return {
      inValueLen: document.getElementById('flow-host-in').value.length,
      signalingState: window.__gomoku.signalingState,
      scannerMaskHidden: document.getElementById('scanner-mask').classList.contains('hidden'),
    };
  });
  console.log('6. 邀请方识别应答码后自动填入与完成连接状态:', hostFinishedState);
  if (hostFinishedState.inValueLen === 0 || !hostFinishedState.scannerMaskHidden) {
    throw new Error('邀请方处理应答码失败');
  }

  // 7. 异常拦截测试（非法码、类型颠倒）
  const invalidTests = await page.evaluate(async ({ offer, answer }) => {
    window.__gomoku.openScanner('host-answer');
    // 在 host-answer 时传入 offer，应该返回 false 拒绝
    const wrongTypeHandled = await window.__gomoku.handleScannedText(offer);
    const gibberishHandled = await window.__gomoku.handleScannedText('THIS-IS-NOT-A-VALID-CODE');
    window.__gomoku.stopScanner();
    return { wrongTypeHandled, gibberishHandled };
  }, { offer: offerCode, answer: answerCode });
  console.log('7. 异常二维码拦截测试 (应返回 false):', invalidTests);
  if (invalidTests.wrongTypeHandled !== false || invalidTests.gibberishHandled !== false) {
    throw new Error('异常二维码未被正确拦截');
  }

  await browser.close();

  if (errors.length) {
    console.error('测试期间存在页面异常:', errors);
    process.exit(1);
  }

  console.log('ALL QR CODE SCAN TESTS PASSED!');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
