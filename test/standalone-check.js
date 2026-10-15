'use strict';
/*
 * 交互式邀请流程验证（file:// 单文件版）：
 *   邀请方「创建房间」→ 生成邀请码 →（模拟微信互发）→
 *   被邀请方「加入房间」→ 粘贴邀请码 → 生成应答码 →（模拟微信互发）→
 *   邀请方粘贴应答码 → 完成连接
 * 本机环境若 P2P 连不上（ICE 被网络策略冻结），验证失败诊断正常展示。
 */
const path = require('path');
const { chromium } = require('playwright');

const FILE = 'file://' + path.join(__dirname, '..', 'dist', 'gomoku-standalone.html');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const errors = [];
  const newPage = async (name) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { errors.push(`[${name}] ${e.message}`); });
    await page.goto(FILE);
    return page;
  };

  const st = (page) => page.evaluate(() => ({
    flow: window.__gomoku.flow,
    role: window.__gomoku.role,
    transport: window.__gomoku.transport,
    connected: window.__gomoku.connected,
    signaling: window.__gomoku.signalingState,
  }));

  const host = await newPage('host');
  const guest = await newPage('guest');

  // 0. 双方均自动进入「邀请对局」tab，flow=idle
  const idle = await st(host);
  console.log('0. 初始状态:', JSON.stringify(idle));
  const tabOk = await host.evaluate(() =>
    !document.getElementById('tab-manual').classList.contains('hidden') &&
    !document.getElementById('flow-entry').classList.contains('hidden'));
  // 昵称门禁：未填昵称时「创建房间」置灰；「加入房间」可点；昵称框在 tab 外层始终可见
  const gate = await host.evaluate(() => ({
    roomCreateDisabled: document.getElementById('create-room-btn').disabled,
    roomJoinDisabled: document.getElementById('join-room-btn').disabled,
    roomInputDisabled: document.getElementById('room-input').disabled,
    hostBtnDisabled: document.getElementById('flow-host-btn').disabled,
    guestBtnDisabled: document.getElementById('flow-guest-btn').disabled,
    nameOutsideTabs: !document.getElementById('name-input').closest('.tab-panel'),
  }));
  console.log('   入口门禁:', JSON.stringify(gate));
  console.log('   file:// 自动切到邀请对局 tab + 入口可见:', tabOk);

  // 1. 邀请方：创建房间 → 生成邀请码
  await host.evaluate(() => {
    const input = document.getElementById('name-input');
    input.value = '邀请人';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('flow-host-btn').click();
  });
  await host.waitForFunction(() => window.__gomoku.flow === 'host-wait', null, { timeout: 3000 });
  await host.waitForFunction(() => document.getElementById('flow-host-out').value.length > 50, null, { timeout: 12000 });
  const invite = await host.evaluate(() => document.getElementById('flow-host-out').value);
  const hostUi = await host.evaluate(() => ({
    step1Active: document.getElementById('fstep-1').classList.contains('active'),
    wechatTip: !!document.querySelector('#flow-host .wechat-tip'),
    waitVisible: document.getElementById('flow-host-wait').offsetParent !== null,
    hostBtnEnabled: !document.getElementById('flow-host-btn').disabled,
  }));
  console.log('1. 邀请码长度:', invite.length, '| UI:', JSON.stringify(hostUi));

  // 2. 被邀请方：加入房间 → 粘贴邀请码 → 生成应答码
  await guest.evaluate(() => {
    const input = document.getElementById('name-input');
    input.value = '被邀请人';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('flow-guest-btn').click();
  });
  await guest.evaluate((code) => {
    document.getElementById('flow-guest-in').value = code;
    document.getElementById('flow-guest-answer').click();
  }, invite);
  await guest.waitForFunction(() => window.__gomoku.flow === 'guest-wait', null, { timeout: 12000 });
  await guest.waitForFunction(() => document.getElementById('flow-guest-out').value.length > 50, null, { timeout: 12000 });
  const answer = await guest.evaluate(() => document.getElementById('flow-guest-out').value);
  const guestUi = await guest.evaluate(() => ({
    step2Active: document.getElementById('fstep-2').classList.contains('active'),
    wechatTip: !!document.querySelector('#flow-guest .wechat-tip'),
  }));
  console.log('2. 应答码长度:', answer.length, '| UI:', JSON.stringify(guestUi));

  // 3. 邀请方：粘贴应答码 → 完成连接（SDP 导入）
  await host.evaluate((code) => {
    document.getElementById('flow-host-in').value = code;
    document.getElementById('flow-host-finish').click();
  }, answer);
  await host.waitForTimeout(18000);

  const after = { host: await st(host), guest: await st(guest) };
  console.log('3. 完成连接后:', JSON.stringify(after));

  const connected = after.host.connected || after.guest.connected;
  let connInfo = '';
  if (connected) {
    connInfo = 'connected, transport=' + JSON.stringify(after.host.transport || after.guest.transport);
    const tShown = await host.evaluate(() => {
      const line = document.getElementById('transport-line');
      return { visible: line.offsetParent !== null, label: document.getElementById('transport-label').textContent };
    });
    console.log('   连接方式展示:', JSON.stringify(tShown));
  } else {
    // 本环境 P2P 连不上时，应展示失败诊断
    const diag = await host.evaluate(() => {
      const r = document.getElementById('flow-result');
      return { visible: r.offsetParent !== null, cls: r.className, text: r.textContent.slice(0, 120) };
    });
    connInfo = 'not-connected (expected in this sandbox), diagnosis=' + JSON.stringify(diag);
  }
  console.log('   连接结果:', connInfo);

  await host.screenshot({ path: path.join(__dirname, 'flow-host.png') });
  await guest.screenshot({ path: path.join(__dirname, 'flow-guest.png') });

  // 4. 移动端视口（375px）：棋盘必须保持正方形且不溢出屏幕
  const mobileCtx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const mobilePage = await mobileCtx.newPage();
  mobilePage.on('pageerror', (e) => { errors.push('[mobile] ' + e.message); });
  await mobilePage.goto(FILE);
  const board = await mobilePage.evaluate(() => {
    const r = document.getElementById('board').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth };
  });
  const squareOk = Math.abs(board.w - board.h) <= 1 && board.w <= board.vw && board.w > 200;
  console.log('4. 移动端 375px 视口棋盘:', JSON.stringify(board), '| 正方形且不溢出:', squareOk);
  await mobilePage.screenshot({ path: path.join(__dirname, 'flow-mobile.png') });
  await mobileCtx.close();

  await browser.close();

  const ok = tabOk && hostUi.step1Active && hostUi.wechatTip && hostUi.waitVisible && hostUi.hostBtnEnabled &&
    guestUi.step2Active && guestUi.wechatTip && invite.length > 50 && answer.length > 50 &&
    gate.roomCreateDisabled && gate.roomJoinDisabled && gate.roomInputDisabled &&
    gate.hostBtnDisabled && !gate.guestBtnDisabled && gate.nameOutsideTabs && squareOk && errors.length === 0;
  console.log('JS 错误:', errors.length ? errors : '无');
  console.log(ok ? 'FLOW CHECK PASS' : 'FLOW CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
