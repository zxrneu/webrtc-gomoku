'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || 'output/lobby-edge-browser.json';
const outcomes = [];
async function scenario(name, fn) {
  try { const detail = await fn(); outcomes.push({ name, passed: true, detail }); console.log('PASS', name, detail || ''); }
  catch (error) { outcomes.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message); }
}
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    await scenario('同浏览器第三窗口拒绝后保留明确原因', async () => {
      const context = await browser.newContext();
      try {
        const pages = [];
        for (let i = 0; i < 3; i++) {
          const p = await context.newPage(); pages.push(p); await p.goto(BASE + '/lobby');
          if (i < 2) await p.locator('#quick-match:enabled').waitFor();
        }
        await pages[2].getByRole('button', { name: '重试', exact: true }).waitFor();
        await pages[2].waitForTimeout(5500);
        const text = await pages[2].locator('#lobby-panel').innerText();
        assert.ok(text.includes('同一浏览器最多 2 桌'), text);
        await pages[0].close();
        await pages[2].getByRole('button', { name: /重试/ }).click();
        await pages[2].locator('#quick-match:enabled').waitFor();
      } finally { await context.close(); }
    });
    await scenario('从已有大厅打开新窗口应有独立窗口身份', async () => {
      const context = await browser.newContext();
      try {
        const a = await context.newPage(); await a.goto(BASE + '/lobby');
        await a.locator('#quick-match:enabled').waitFor();
        const popup = context.waitForEvent('page');
        await a.evaluate(() => window.open(location.href, '_blank'));
        const b = await popup; await b.waitForLoadState();
        await b.locator('#quick-match:enabled').waitFor();
        const ids = await Promise.all([a, b].map(p => p.evaluate(() => sessionStorage.getItem('gomoku:lobby-tab'))));
        await b.reload(); await b.locator('#quick-match:enabled').waitFor();
        assert.equal(await b.evaluate(() => sessionStorage.getItem('gomoku:lobby-tab')), ids[1], '弹窗刷新应保留自己的身份');
        await a.getByRole('button', { name: '刷新大厅', exact: true }).click();
        await a.waitForTimeout(200);
        const oldText = await a.locator('#lobby-panel').innerText();
        assert.notEqual(ids[0], ids[1], `新窗口复制 sessionStorage 后不应被误判为旧窗口刷新；旧窗口状态：${oldText}`);
        assert.equal(await a.getByText('请先进入大厅', { exact: true }).count(), 0);
      } finally { await context.close(); }
    });
    await scenario('换边后加入方刷新、双方同时刷新均保留棋谱和执色', async () => {
      // Expose local ICE interfaces in the test environment without opening a physical microphone.
      const contexts = await Promise.all([browser.newContext({ permissions: ['microphone'] }), browser.newContext({ permissions: ['microphone'] })]);
      try {
        const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
        await Promise.all([a, b].map(p => p.goto(BASE + '/lobby')));
        await Promise.all([a, b].map(p => p.locator('#quick-match:enabled').waitFor()));
        await a.locator('#quick-match').click(); await b.locator('#quick-match').click();
        const connected = p => p.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 30000 });
        await Promise.all([connected(a), connected(b)]);
        await a.locator('#toggle-color-btn').click(); await b.locator('#modal-ok').click();
        await b.waitForFunction(() => window.__gomoku.myColor === 1);
        await b.locator('#board').click({ position: { x: 280, y: 280 } });
        await a.waitForFunction(() => window.__gomoku.moves.length === 1);
        const expected = await a.evaluate(() => window.__gomoku.moves);
        const popupEvent = contexts[0].waitForEvent('page');
        await a.evaluate(() => window.open(location.href, '_blank'));
        const popup = await popupEvent; await popup.waitForLoadState();
        await popup.locator('#quick-match:enabled').waitFor();
        assert.equal(await popup.evaluate(() => sessionStorage.getItem('gomoku:lobby-session')), null, '新弹窗不能继承并接管原局座位');
        assert.equal(await a.evaluate(() => window.__gomoku.connected), true);
        await popup.close();
        const check = async () => {
          await Promise.all([connected(a), connected(b)]);
          await Promise.all([a, b].map(p => p.waitForFunction(() => window.__gomoku.moves.length === 1)));
          assert.equal(await a.evaluate(() => window.__gomoku.myColor), 2);
          assert.equal(await b.evaluate(() => window.__gomoku.myColor), 1);
          for (const p of [a, b]) {
            assert.deepEqual(await p.evaluate(() => window.__gomoku.moves), expected);
            await p.waitForFunction(() => !!window.__gomoku.peerName && window.__gomoku.peerCapabilities?.audio === true);
            await p.getByRole('tab', { name: /聊天/ }).click();
            await p.locator('#chat-voice-btn:enabled').waitFor({ state: 'visible' });
            await p.getByRole('tab', { name: '对局', exact: true }).click();
          }
        };
        await b.reload(); await check();
        for (let n = 0; n < 3; n++) { await Promise.all([a.reload(), b.reload()]); await check(); }
        return '加入方刷新 + 连续 3 次双方同时刷新';
      } finally { await Promise.all(contexts.map(c => c.close())); }
    });
  } finally {
    await browser.close(); fs.mkdirSync(require('node:path').dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(outcomes, null, 2) + '\n');
    if (outcomes.some(result => !result.passed)) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
