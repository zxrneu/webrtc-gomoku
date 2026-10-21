'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';

async function startAi(page) {
  await page.locator('#lobby-ai-btn').click();
  await page.waitForFunction(() => window.__gomoku.mode === 'ai');
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const contexts = [];
  const pages = [];
  const errors = [];
  try {
    for (let i = 0; i < 2; i++) {
      // 与联机回归保持一致：允许本地 ICE 网卡，兼容默认路由经过 VPN 的宿主机。
      const context = await browser.newContext({ viewport: { width: 375, height: 667 }, permissions: ['microphone'] });
      contexts.push(context);
      await context.addInitScript(() => {
        localStorage.setItem('gomoku.ai.playerColor', '1');
        localStorage.setItem('gomoku.ai.difficulty', 'easy');
        window.__navigationDocument = 0;
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      pages.push(page);
      await page.goto(BASE);
      await page.locator('#quick-match:enabled').waitFor();
    }
    const [a, b] = pages;
    await startAi(a);
    const board = await a.locator('#board').boundingBox();
    await a.mouse.click(board.x + board.width / 2, board.y + board.height / 2);
    await a.waitForFunction(() => window.__gomoku.ai.moves.length === 2 && !window.__gomoku.ai.thinking);
    const aiMoves = await a.evaluate(() => window.__gomoku.ai.moves);
    await a.locator('#mode-online-btn').click();
    await a.locator('#lobby-page').waitFor({ timeout: 3000 });
    assert.match(a.url(), /\/lobby$/);
    assert.equal(await a.locator('#lobby-board-btn').count(), 0, '无房间时不提供旧版空棋盘入口');
    assert.equal(await a.locator('#board').isVisible(), false);
    await a.goBack();
    assert.equal(await a.locator('#board').isVisible(), false, '浏览器返回也不进入无人房联机页');
    await startAi(a);
    assert.deepEqual(await a.evaluate(() => window.__gomoku.ai.moves), aiMoves);
    await a.locator('#mode-online-btn').click();

    await a.locator('#lobby-create').click();
    await a.waitForFunction(() => window.__gomoku.room.length === 4);
    const room = await a.locator('#room-code-text').innerText();
    await a.getByRole('button', { name: '服务大厅', exact: true }).click();
    await a.getByLabel('在大厅展示房间', { exact: true }).click();
    await a.waitForFunction(() => [...document.querySelectorAll('label')].some(label =>
      label.textContent.includes('在大厅展示房间') && label.querySelector('input')?.checked === false));
    await a.locator('#lobby-board-btn').click();
    await a.locator('#mode-ai-btn').click();
    await a.locator('#mode-online-btn').click();
    assert.equal(await a.locator('#room-code-text').innerText(), room, '等待中的房间原样返回');
    assert.equal(await a.locator('#player-trays').isVisible(), true);

    await startAi(b);
    await b.locator('#mode-online-btn').click();
    await b.locator('#lobby-page').waitFor();
    const documentId = await b.evaluate(() => ++window.__navigationDocument);
    await b.locator('#lobby-room-code').fill('ZZZZ');
    await b.locator('#lobby-join-btn').click();
    await b.locator('#lobby-panel').getByText(/房间 ZZZZ 不存在/).waitFor();
    await b.locator('#lobby-room-code').fill(room.toLowerCase());
    await b.locator('#lobby-join-btn').click();
    await Promise.all(pages.map(page => page.waitForFunction(() => window.__gomoku.connected, null, { timeout: 20000 })));
    assert.equal(await b.evaluate(() => window.__navigationDocument), documentId, '按私密房号加入不刷新页面');
    const black = (await a.evaluate(() => window.__gomoku.myColor)) === 1 ? a : b;
    const onlineBoard = await black.locator('#board').boundingBox();
    await black.mouse.click(onlineBoard.x + onlineBoard.width / 2, onlineBoard.y + onlineBoard.height / 2);
    await Promise.all(pages.map(page => page.waitForFunction(() => window.__gomoku.moves.length === 1)));
    for (const page of pages) {
      const moves = await page.evaluate(() => window.__gomoku.moves);
      await page.locator('#mode-ai-btn').click();
      if (page === a) assert.deepEqual(await page.evaluate(() => window.__gomoku.ai.moves), aiMoves);
      await page.locator('#mode-online-btn').click();
      assert.equal(await page.locator('#room-code-text').innerText(), room);
      assert.deepEqual(await page.evaluate(() => window.__gomoku.moves), moves);
      assert.equal(await page.locator('#player-trays').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), true);
    }
    await a.screenshot({ path: 'output/playwright/mode-navigation-room-mobile.png' });
    await a.getByRole('button', { name: '服务大厅', exact: true }).click();
    await a.locator('#lobby-board-btn').click();
    assert.equal(await a.locator('#room-code-text').innerText(), room);
    assert.deepEqual(errors, []);
    console.log('ok - 无房间切回大厅、返回历史保护、等待/已连接房间恢复、站内加入及两套棋谱保留');
  } finally {
    for (const page of pages) {
      try { const leave = page.getByRole('button', { name: '退出房间', exact: true }); if (await leave.isVisible()) await leave.click(); } catch {}
    }
    for (const context of contexts) await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
