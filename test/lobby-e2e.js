'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
async function setAiColor(page, color) {
  await page.waitForFunction(() => window.__gomoku.mode === 'ai');
  const current = (await page.locator('#black-name').innerText()) === '我' ? 1 : 2;
  if (current !== color) await page.locator('#toggle-color-btn').click();
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  try {
    async function player(name) {
      // Permit local ICE interfaces even on hosts whose default route is a VPN; no real microphone is used.
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone'] });
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
    async function playAiInRoom(page, code) {
      const onlineMoves = await page.evaluate(() => window.__gomoku.moves);
      if (await page.locator('#conn-banner').count()) {
        await page.locator('#conn-banner').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
        const banner = await page.locator('#conn-banner').boundingBox();
        const header = await page.locator('header.topbar').boundingBox();
        assert.ok(banner.y >= header.y + header.height, '等待房间时横幅不盖住人机入口');
        assert.equal(await page.locator('#overlay-text').innerText().then(text => text.includes('创建或加入房间')), false);
      }
      assert.equal(await page.locator('#create-room-btn').count(), 0, '入房后不显示创建房间');
      assert.equal(await page.locator('#join-room-btn').count(), 0, '入房后不显示加入表单');

      await page.locator('#switch-room-btn').click();
      assert.equal(await page.locator('#create-room-btn').isVisible(), true);

      await page.locator('#switch-room-btn').click();
      assert.equal(await page.locator('#create-room-btn').count(), 0, '取消换房后收起表单');
      await page.locator('#mode-ai-btn').click();
      await setAiColor(page, 1);
      const board = await page.locator('#board').boundingBox();
      const scale = board.width / 560;
      await page.mouse.click(board.x + (28 + 7 * 36) * scale, board.y + (28 + 7 * 36) * scale);
      await page.waitForFunction(() => window.__gomoku.ai.moves.length === 2 && !window.__gomoku.ai.thinking);
      assert.equal(await page.evaluate(() => window.__gomoku.room), code, '人机对战保留房间');
      assert.deepEqual(await page.evaluate(() => window.__gomoku.moves), onlineMoves, '人机落子不改变联机棋谱');
      await page.locator('#mode-online-btn').click();
      assert.equal(await page.locator('#room-code-text').innerText(), code);
      assert.equal(await page.locator('#tab-manual').count(), 0, '服务器房间不渲染手动信令表单');
      assert.equal(await page.locator('[data-online-tab="manual"]').count(), 0, '服务器没有手动信令入口');
      assert.equal(await page.getByText('进入房间自动连接 · 也可随时切换人机对战').count(), 1);
    }
    const a = await player('松间棋友'); const b = await player('听雨棋友');
    await a.getByText('听雨棋友', { exact: true }).waitFor();
    await a.setViewportSize({ width: 375, height: 900 });
    await a.locator('#lobby-ai-btn').click();
    await a.waitForFunction(() => window.__gomoku.mode === 'ai');
    await setAiColor(a, 1);
    await a.locator('#board').scrollIntoViewIfNeeded();
    const aiBoard = await a.locator('#board').boundingBox();
    const aiScale = aiBoard.width / 560;
    await a.mouse.click(aiBoard.x + (28 + 7 * 36) * aiScale, aiBoard.y + (28 + 7 * 36) * aiScale);
    await a.waitForFunction(() => window.__gomoku.ai.moves.length === 2 && !window.__gomoku.ai.thinking);
    assert.equal(await a.evaluate(() => window.__gomoku.room), '', '大厅直接开始人机，无需建房');
    for (const width of [320, 375]) {
      await a.setViewportSize({ width, height: 900 });
      const button = await a.locator('#mode-online-btn').boundingBox();
      assert.ok(button.x >= 0 && button.x + button.width <= width && button.y < 160, '手机上模式入口位于顶部视口内');
      assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await a.locator('#mode-online-btn').click();
    await a.locator('[data-online-tab="lobby"]').click();
    await a.setViewportSize({ width: 1440, height: 1000 });
    console.log('ok - 大厅手机端直接进入人机并真实落子，切回可返回大厅');

    async function checkHierarchy(page) {
      const match = await page.locator('#quick-match').boundingBox();
      const create = await page.locator('#lobby-create').boundingBox();
      const launch = await page.getByRole('complementary', { name: '开局操作' }).boundingBox();
      const browse = await page.getByRole('region', { name: '棋友与房间' }).boundingBox();
      const mobile = page.viewportSize().width <= 600;
      assert.ok(match.height >= 44 && create.height >= 44, '开局入口保留足够的点击面积');
      if (mobile) {
        assert.ok(match.width > create.width, '手机上快速匹配占整行，建房为次要入口');
        assert.ok(browse.y >= launch.y + launch.height, '手机上先开局操作，再浏览棋友');
        assert.ok(browse.y < 650, '手机上棋友列表不被开局操作推到过低的位置');
      } else {
        assert.ok(browse.x >= launch.x + launch.width, '桌面上左侧开局，右侧浏览棋友');
        assert.ok(Math.abs(browse.y - launch.y) <= 1, '开局区与棋友区顶部对齐');
      }
      for (const radio of await page.getByRole('radio').all()) {
        assert.ok((await radio.boundingBox()).height >= 38, '大厅内容切换入口应易于点击');
        assert.ok(await radio.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 14);
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
    await playAiInRoom(a, code);
    assert.equal(await b.evaluate(() => window.__gomoku.moves.length), 1);
    console.log('ok - 自动信令真实 P2P、落子同步、已连通房间切换人机并保留棋谱');
    await a.reload();
    await a.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 25000 });
    await a.waitForFunction(() => window.__gomoku?.moves?.length === 1);
    assert.equal(await a.locator('#room-code-text').innerText(), code);
    assert.equal(await a.evaluate(() => window.__gomoku.myColor), 2, '房主刷新后仍执白');
    assert.equal(await b.evaluate(() => window.__gomoku.myColor), 1, '对手刷新恢复后仍执黑');
    console.log('ok - 刷新恢复原房间、棋谱和换边后的执色');
    for (const p of [a, b]) { await p.getByRole('button', { name: '退出房间', exact: true }).click(); }
    await a.locator('#lobby-create').click();
    await a.waitForFunction(() => window.__gomoku?.room?.length === 4);
    const publicCode = await a.locator('#room-code-text').innerText();
    await playAiInRoom(a, publicCode);
    console.log('ok - 房间等待对手时可下人机，切回仍能接受对手加入');
    await b.getByRole('radio', { name: /房间广场/ }).click();
    await b.locator(`[data-join-room="${publicCode}"]`).click();
    await b.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 20000 });
    console.log('ok - 公开房间展示与加入');

    await a.getByRole('button', { name: '退出房间', exact: true }).click();

    await b.getByRole('button', { name: '退出房间', exact: true }).click();
    // 新对手验证接受邀请，避免拒绝后的 60 秒冷却。
    await b.context().close(); const c = await player('竹影棋友');
    await a.locator('li').filter({ has: a.getByText('竹影棋友', { exact: true }) }).locator('[data-invite-user]').click();
    await c.getByRole('button', { name: '接受邀请', exact: true }).click();
    await a.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 20000 });
    await c.waitForFunction(() => window.__gomoku?.connected === true, null, { timeout: 20000 });
    console.log('ok - 接受定向邀请后自动组房并真实直连');

    await c.getByRole('button', { name: '退出房间', exact: true }).click();
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
