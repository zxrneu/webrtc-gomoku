'use strict';
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
const prefix = BASE.startsWith('https:') ? 'room-board-live' : 'room-board-local';

async function checkLayout(page, width, height, phase) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: `output/playwright/${prefix}-${phase}-${width}x${height}.png` });
  const board = await page.locator('#board').boundingBox();
  const heading = await page.locator('#room-info').boundingBox();
  const footer = await page.locator('#room-navigation').boundingBox();
  assert.ok(footer.y + footer.height <= height, '底部房间操作无需滚动');
  if (await page.locator('#transport-label').count()) {
    assert.equal(await page.locator('#transport-label').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, '连接类型及延迟不截断');
    const info = await page.evaluate(() => ({ rtt: window.__gomoku.transport?.rtt, text: document.getElementById('transport-label').textContent }));
    if (info.rtt !== undefined) assert.ok(info.text.includes(`${info.rtt}ms`), '测得的延迟完整显示');
  }
  const actions = await page.locator('.board-actions').boundingBox();
  const black = await page.locator('#player-black').boundingBox();
  const white = await page.locator('#player-white').boundingBox();
  const swap = await page.locator('#toggle-color-btn').boundingBox();
  assert.ok(swap.x >= black.x + black.width && swap.x + swap.width <= white.x, '换边按钮位于两个棋盒之间');
  assert.ok(swap.y >= black.y && swap.y + swap.height <= black.y + black.height, '换边按钮与棋盒同排');
  assert.ok(heading.y + heading.height <= board.y && board.y - heading.y - heading.height <= 12, '房间号紧邻棋盘正上方');
  assert.ok(Math.abs(heading.x + heading.width / 2 - board.x - board.width / 2) < 2, '房间标题与棋盘居中对齐');
  assert.ok(actions.y + actions.height <= height, `${width}×${height} 常用操作无需滚动`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), `${width}×${height} 对弈页面无需滚动`);
  assert.equal(await page.locator('#room-code-text').count(), 1, '房间号只展示一处');
  assert.equal(await page.locator('#connect-card').isVisible(), false, '设置默认收起');
  await page.screenshot({ path: `output/playwright/${prefix}-${phase}-${width}x${height}.png` });
}

(async () => {
  mkdirSync('output/playwright', { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-features=WebRtcHideLocalIpsWithMdns',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  const pages = [];
  try {
    async function player(name) {
      const context = await browser.newContext({ viewport: { width: 375, height: 667 }, permissions: ['microphone'] });
      const page = await context.newPage();
      pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(BASE);
      await page.locator('#quick-match:enabled').waitFor();
      await page.getByRole('button', { name: '修改', exact: true }).click();
      await page.locator('#lobby-name').fill(name);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.locator('#lobby-name').waitFor({ state: 'detached' });
      return page;
    }
    const a = await player('松间棋友');
    const b = await player('听雨棋友');
    for (const [width, height] of [[320, 568], [375, 667], [1440, 900]]) {
      await a.setViewportSize({ width, height });
      await a.locator('[data-invite-user]').first().waitFor();
      const row = await a.locator('[aria-label="在线棋友列表"] li').first().boundingBox();
      assert.ok(row.y + row.height <= height, '首页首屏直接看到棋友');
      assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await a.locator('[aria-label="在线棋友列表"]').getByText('松间棋友', { exact: true }).count(), 0);
      await a.screenshot({ path: `output/playwright/${prefix}-home-${width}x${height}.png` });
    }
    await a.setViewportSize({ width: 375, height: 667 });
    await a.locator('#lobby-create').click();
    await a.waitForFunction(() => window.__gomoku.room.length === 4);
    const code = await a.locator('#room-code-text').innerText();
    await checkLayout(a, 320, 568, 'waiting');
    await b.locator('#lobby-room-code').fill('???');
    assert.equal(await b.locator('#lobby-join-btn').isDisabled(), true);
    await b.locator('#lobby-room-code').fill(code.toLowerCase());
    await b.locator('#lobby-join-btn').click();
    await a.waitForFunction(() => window.__gomoku.connected, null, { timeout: 20000 });
    await b.waitForFunction(() => window.__gomoku.connected, null, { timeout: 20000 });
    await a.getByRole('button', { name: '拿起黑棋', exact: true }).click();
    assert.match(await a.locator('#player-black').innerText(), /已拿起/);
    assert.equal(await a.evaluate(() => document.activeElement.id), 'board', '拿棋后焦点交给棋盘，页面不滚动');
    assert.equal(await a.getByRole('button', { name: '拿起白棋', exact: true }).isDisabled(), true);
    const board = await a.locator('#board').boundingBox();
    await a.mouse.click(board.x + board.width / 2, board.y + board.height / 2);
    await b.waitForFunction(() => window.__gomoku.moves.length === 1);
    assert.equal(await a.getByRole('button', { name: '拿起黑棋', exact: true }).isDisabled(), true);
    assert.equal(await b.getByRole('button', { name: '拿起白棋', exact: true }).isEnabled(), true);
    assert.match(await a.locator('#black-tag').innerText(), /房主/);
    await a.waitForFunction(() => window.__gomoku.transport?.rtt !== undefined);
    await a.locator('#toast').waitFor({ state: 'hidden' });
    for (const [width, height] of [[320, 568], [375, 667], [390, 844], [768, 900], [1440, 768], [1440, 1000]]) {
      await checkLayout(a, width, height, 'playing');
    }
    await a.setViewportSize({ width: 375, height: 667 });
    await a.locator('#toggle-color-btn').click();
    await b.locator('#modal-ok').click();
    await a.waitForFunction(() => window.__gomoku.myColor === 2);
    await b.waitForFunction(() => window.__gomoku.myColor === 1);
    assert.match(await a.locator('#toggle-color-btn').getAttribute('aria-label'), /当前执白/);
    assert.match(await a.locator('#white-name').innerText(), /松间棋友/);
    assert.match(await a.locator('#white-tag').innerText(), /房主/);

    assert.equal(await a.locator('#toggle-color-btn').count(), 1);
    assert.equal(await a.locator('#room-settings-panel #toggle-color-btn').count(), 0);
    assert.equal(await a.locator('#switch-room-btn').isVisible(), true);
    await a.screenshot({ path: `output/playwright/${prefix}-footer-mobile.png` });
    assert.equal(await a.locator('#room-settings-btn').count(), 0);
    assert.equal(await a.getByRole('tab').count(), 0);
    assert.equal(await a.locator('#room-navigation').isVisible(), true);
    await a.getByRole('button', { name: '修改我的昵称', exact: true }).click();
    await a.locator('#player-name-input').fill('松间新名');
    await a.getByRole('button', { name: '保存', exact: true }).click();
    await b.waitForFunction(() => window.__gomoku.peerName === '松间新名');
    assert.match(await a.locator('#white-name').innerText(), /松间新名/);
    assert.equal(await a.locator('dialog[open]').count(), 0);
    await a.getByRole('button', { name: '打开聊天', exact: true }).click();
    for (const width of [320, 375, 390]) {
      await a.setViewportSize({ width, height: 667 });
      const input = await a.locator('#chat-input').boundingBox();
      const send = await a.locator('#chat-send-btn').boundingBox();
      const image = await a.locator('#chat-image-btn').boundingBox();
      assert.ok(Math.abs(input.y - send.y) <= 1, '聊天输入框和发送按钮保持同一行');
      assert.ok(image.y + image.height <= input.y, '图片等工具独立一行');
      if (await a.locator('#toast').isVisible()) {
        const toast = await a.locator('#toast').boundingBox();
        assert.ok(toast.y + toast.height <= image.y, '临时提示不遮挡聊天工具与输入框');
      }
      assert.ok(input.width >= width - 110 && send.x + send.width <= width - 8, '输入框充足，发送按钮完整显示');
      await a.screenshot({ path: `output/playwright/${prefix}-chat-${width}.png` });
    }
    await a.locator('#chat-input').fill('棋盒旁边能看到你了');
    await a.locator('#chat-send-btn').click();
    await b.locator('#chat-preview').waitFor();
    await a.keyboard.press('Escape');
    await a.getByRole('button', { name: '服务大厅', exact: true }).click();
    await a.locator('#lobby-page').waitFor();
    assert.equal(await a.getByText('松间新名', { exact: true }).count(), 1);
    await a.locator('#lobby-board-btn').click();
    assert.equal(await a.evaluate(() => window.__gomoku.myColor), 2);
    assert.equal(await a.evaluate(() => window.__gomoku.moves.length), 1);
    assert.deepEqual(errors, []);
    console.log('ok - 棋盒拿棋与真实落子、房主信息、首页与房号加入、点击昵称修改、底部房间操作、延迟完整显示、聊天输入两行及六种屏幕免滚动布局');
  } finally {
    for (const page of pages) {
      try {

        const leave = page.getByRole('button', { name: '退出房间', exact: true });
        if (await leave.isVisible()) await leave.click();
      } catch {}
    }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
