'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  try {
    async function player(name) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(BASE); await page.locator('#lobby-panel').waitFor();
      assert.equal(await page.locator('#board').isVisible(), false);
      assert.match(page.url(), /\/lobby$/);
      await page.waitForFunction(() => document.querySelector('#lobby-panel')?.textContent.includes('在线 1') || document.querySelector('#quick-match')?.disabled === false);
      await page.getByRole('button', { name: '修改', exact: true }).click();
      await page.locator('#lobby-name').fill(name); await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(n => document.querySelector('#lobby-panel')?.textContent.includes(n) && !document.querySelector('#lobby-name'), name);
      return page;
    }
    const a = await player('松间棋友'); const b = await player('听雨棋友');
    await a.getByText('听雨棋友', { exact: true }).waitFor();
    async function checkHierarchy(page) {
      const match = await page.locator('#quick-match').boundingBox();
      const create = await page.locator('#lobby-create').boundingBox();
      assert.ok(Math.abs(match.height - create.height) <= 1, '匹配和开桌入口应等高');
      assert.ok(Math.abs(match.width - create.width) <= 1, '匹配和开桌入口应等宽');
      for (const radio of await page.getByRole('radio').all()) {
        assert.ok((await radio.boundingBox()).height >= 48, '大厅内容切换入口应易于点击');
        assert.ok(await radio.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
      }
    }
    await checkHierarchy(a);
    fs.mkdirSync('output/playwright', { recursive: true });
    await a.screenshot({ path: 'output/playwright/lobby-desktop.png', fullPage: true });
    await a.locator('li').filter({ has: a.getByText('听雨棋友', { exact: true }) }).locator('[data-invite-user]').click();
    await b.locator('#incoming-invite').waitFor();
    await b.getByRole('button', { name: '暂不接受', exact: true }).click();
    await a.locator('#outgoing-invite').waitFor({ state: 'detached' });
    console.log('ok - 在线名册、定向邀请、拒绝同步');
    // 拒绝有同组冷却；切换快速匹配验证另一条入座路径。
    await a.locator('#quick-match').click();
    await a.getByRole('button', { name: '取消匹配', exact: true }).click();
    await a.locator('#quick-match').waitFor();
    await a.locator('#quick-match').click(); await b.locator('#quick-match').click();
    await a.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 20000 });
    await b.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 20000 });
    const code = await a.locator('#room-code-text').innerText();
    assert.equal(await b.locator('#room-code-text').innerText(), code);
    await a.locator('#toggle-color-btn').click(); await b.locator('#modal-ok').click();
    await a.waitForFunction(() => window.__gomoku.myColor === 2);
    await b.waitForFunction(() => window.__gomoku.myColor === 1);
    const board = await b.locator('#board').boundingBox();
    await b.mouse.click(board.x + 28 + 7 * 36, board.y + 28 + 7 * 36);
    await a.waitForFunction(() => window.__gomoku?.moves?.length === 1);
    console.log('ok - 匹配取消、真实 P2P、落子同步');
    await a.reload();
    await a.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 25000 });
    await a.waitForFunction(() => window.__gomoku?.moves?.length === 1);
    assert.equal(await a.locator('#room-code-text').innerText(), code);
    assert.equal(await a.evaluate(() => window.__gomoku.myColor), 2, '房主刷新后仍执白');
    assert.equal(await b.evaluate(() => window.__gomoku.myColor), 1, '对手刷新恢复后仍执黑');
    console.log('ok - 刷新恢复原房间、棋谱和换边后的执色');
    for (const p of [a, b]) { await p.getByRole('button', { name: '离开房间，返回大厅', exact: true }).click(); }
    await a.locator('#lobby-create').click();
    await a.waitForFunction(() => window.__gomoku?.room?.length === 4);
    const publicCode = await a.locator('#room-code-text').innerText();
    await b.getByRole('radio', { name: /房间广场/ }).click();
    await b.locator(`[data-join-room="${publicCode}"]`).click();
    await b.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 20000 });
    console.log('ok - 公开房间展示与加入');
    await a.getByRole('button', { name: '离开房间，返回大厅', exact: true }).click();
    await b.getByRole('button', { name: '离开房间，返回大厅', exact: true }).click();
    // 新对手验证接受邀请，避免拒绝后的 60 秒冷却。
    await b.context().close(); const c = await player('竹影棋友');
    await a.locator('li').filter({ has: a.getByText('竹影棋友', { exact: true }) }).locator('[data-invite-user]').click();
    await c.getByRole('button', { name: '接受邀请', exact: true }).click();
    await a.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 20000 });
    await c.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 20000 });
    console.log('ok - 接受定向邀请后自动组房并真实直连');
    await c.getByRole('button', { name: '离开房间，返回大厅', exact: true }).click();
    for (const width of [375, 320]) {
      await c.setViewportSize({ width, height: 900 });
      assert.equal(await c.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await checkHierarchy(c);
      await c.screenshot({ path: `output/playwright/lobby-${width}.png`, fullPage: true });
    }
    const expiredContext = await browser.newContext();
    const expired = await expiredContext.newPage();
    await expired.addInitScript(() => sessionStorage.setItem('gomoku:lobby-session', JSON.stringify({
      name: '过期棋友', moves: [], seat: { t: 'lobby-seat', room: 'ZZZZ', peerId: 'expired-seat', token: 'expired-token', role: 'host' },
    })));
    await expired.goto(BASE);
    await expired.locator('#lobby-page').waitFor();
    await expired.getByText('上一局已结束', { exact: true }).waitFor();
    assert.equal(await expired.locator('#board').isVisible(), false);
    console.log('ok - 过期房间刷新后返回大厅并说明原因');
    assert.deepEqual(errors, []);
    console.log('ok - 手机布局无横向溢出、无页面错误');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
