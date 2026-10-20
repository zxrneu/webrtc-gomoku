'use strict';
/** 真实 Worker、单文件离线、取消恢复与不支持 Worker 时的浏览器回归。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';

async function setAiColor(page, color) {
  await page.waitForFunction(() => window.__gomoku.mode === 'ai');
  const current = (await page.locator('#black-name').innerText()) === '我' ? 1 : 2;
  if (current !== color) await page.locator('#toggle-color-btn').click();
}

async function launch() {
  try { return await chromium.launch(); }
  catch { return chromium.launch({ channel: 'chrome' }); }
}
async function clickCell(page, x, y) {
  const board = page.locator('#board');
  await board.scrollIntoViewIfNeeded();
  const box = await board.boundingBox();
  const scale = box.width / 560;
  await page.mouse.click(box.x + (28 + 36 * x) * scale, box.y + (28 + 36 * y) * scale);
}
async function settle(page, moves) {
  await page.waitForFunction((count) => !window.__gomoku.ai.thinking && window.__gomoku.ai.moves.length === count,
    moves, { timeout: 10000 });
}

async function checkAiLayout(page) {
  for (const width of [320, 375, 1400]) {
    await page.setViewportSize({ width, height: width < 640 ? 667 : 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const difficulty = await page.locator('header #ai-difficulty').boundingBox();
    const board = await page.locator('#board').boundingBox();
    assert.equal(await page.locator('#player-trays').isVisible(), true);
    assert.match(await page.locator('#player-trays').innerText(), /AI（/);
    assert.equal(await page.locator('#toggle-color-btn').getAttribute('aria-label'), '切换执子并重新开局');
    const hint = await page.locator('.board-actions #ai-hint-btn').boundingBox();
    assert.ok(difficulty && difficulty.width <= 90 && difficulty.y >= 0 && difficulty.y + difficulty.height < 200,
      `${width}px 难度选择在顶部且不占满整行`);
    assert.ok(hint && hint.y >= board.y + board.height && hint.y - board.y - board.height <= 40,
      `${width}px AI 提示紧邻棋盘`);
    if (width < 640) {
      assert.ok(hint.y + hint.height <= 667, '手机首屏能直接操作提示');
      const lastAction = await page.locator('#toggle-move-numbers-btn').boundingBox();
      assert.ok(lastAction.y + lastAction.height <= 667, '人机常用操作全部位于首屏');
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), '人机基础对弈页无需滚动');
    }
    assert.equal(await page.getByRole('button', { name: '悔棋', exact: true }).count(), 1, '悔棋只有一个入口');
    assert.equal(await page.getByRole('button', { name: '重新开始', exact: true }).count(), 1, '重开只有一个入口');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '没有横向溢出');
  }
  await page.setViewportSize({ width: 375, height: 667 });
  await page.screenshot({ path: `output/playwright/ai-trays-${page.url().startsWith('file:') ? 'offline' : 'online'}.png` });
  await page.locator('#ai-difficulty').selectOption('normal');
  assert.match(await page.locator('#ai-difficulty-hint').innerText(), /下一局生效/);
  assert.equal(await page.evaluate(() => window.__gomoku.ai.difficulty), 'hard', '更改难度不打断当前局');
  await page.locator('#ai-difficulty').selectOption('hard');
  assert.equal(await page.locator('#ai-difficulty-hint').count(), 0);
}

async function exercise(browser, url, supportsWorker) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.addInitScript((supported) => {
    localStorage.setItem('gomoku.ai.playerColor', '2');
    localStorage.setItem('gomoku.ai.difficulty', 'hard');
    window.__aiWorkerTest = { created: 0, searches: 0, maxGap: 0, longTasks: [] };
    const state = window.__aiWorkerTest;
    if (!supported) window.Worker = undefined;
    else {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); state.created += 1; }
        postMessage(message, ...args) {
          if (message.t === 'search') state.searches += 1;
          return super.postMessage(message, ...args);
        }
      };
    }
    let last = performance.now();
    setInterval(() => { const now = performance.now(); state.maxGap = Math.max(state.maxGap, now - last); last = now; }, 10);
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) if (entry.duration > 100) state.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  }, supportsWorker);
  try {
    await page.goto(url);
    if (await page.locator('#lobby-page').count()) await page.locator('#lobby-board-btn').click();
    await page.waitForFunction(() => !!window.__gomoku);
    await context.setOffline(true);
    const beforeRequests = requests.length;
    await page.click('#mode-ai-btn');
    await settle(page, 1);
    await checkAiLayout(page);
    await page.evaluate(() => { window.__aiWorkerTest.maxGap = 0; window.__aiWorkerTest.longTasks = []; });
    await clickCell(page, 8, 8);
    await settle(page, 3);
    const diagnostic = await page.evaluate(() => window.__aiWorkerTest);
    assert.equal(diagnostic.created, supportsWorker ? 1 : 0, '真实 Worker 创建次数');
    if (supportsWorker) {
      assert.ok(diagnostic.searches >= 2, '搜索确实通过 Worker 消息执行');
      assert.ok(diagnostic.maxGap < 200, `主线程停顿 ${diagnostic.maxGap}ms`);
      assert.deepEqual(diagnostic.longTasks, [], 'AI 思考期间无超过 100ms 的主线程长任务');
    }
    assert.equal(requests.length, beforeRequests, '离线切入人机不请求 Worker 脚本');

    const hintMoves = await page.evaluate(() => window.__gomoku.ai.moves.length);
    await page.click('#ai-hint-btn');
    await page.waitForSelector('#ai-hint-explanation');
    assert.equal(await page.locator('.board-card #ai-hint-explanation').count(), 1, '提示说明直接出现在棋盘操作区');
    assert.match(await page.locator('#ai-hint-explanation').innerText(), /推荐|为什么/);
    assert.equal(await page.evaluate(() => window.__gomoku.ai.moves.length), hintMoves, '提示不代替玩家落子');
    assert.equal(await page.locator('#ai-hint-marker').count(), 1, '棋盘显示推荐点');
    await page.click('#ai-hint-btn');
    await page.waitForSelector('#ai-hint-explanation');
    assert.equal(await page.evaluate(() => window.__gomoku.ai.moves.length), hintMoves, '重复提示仍不落子');

    await clickCell(page, 0, 14);
    await page.waitForFunction(() => window.__gomoku.ai.thinking);
    assert.equal(await page.locator('#ai-hint-marker').count(), 0, '落子清除旧提示');
    assert.equal(await page.locator('#ai-hint-btn').isDisabled(), true, '对手回合不可提示');
    assert.equal(await page.locator('#restart-btn').isDisabled(), true);
    await page.click('#mode-online-btn');
    const cancelledMoves = await page.evaluate(() => window.__gomoku.ai.moves.length);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__gomoku.ai.moves.length), cancelledMoves, '取消后不落旧子');
    await page.click('#mode-ai-btn');
    await settle(page, 5);
    await page.click('#ai-hint-btn');
    await page.waitForSelector('#ai-hint-explanation');
    await page.click('#undo-btn');
    await settle(page, 3);
    assert.equal(await page.locator('#ai-hint-explanation').count(), 0, '悔棋清除旧提示');
    await page.click('#ai-hint-btn');
    await page.click('#restart-btn');
    await settle(page, 1);
    assert.equal(await page.locator('#ai-hint-explanation').count(), 0, '重开取消提示');
    await page.click('#ai-hint-btn');
    await page.click('#mode-online-btn');
    await page.click('#mode-ai-btn');
    assert.equal(await page.locator('#ai-hint-explanation').count(), 0, '切模式取消提示');
    await setAiColor(page, 2);
    await setAiColor(page, 2);
    await settle(page, 1);
    assert.equal(await page.evaluate(() => window.__aiWorkerTest.created), supportsWorker ? 1 : 0, '重开仍复用 Worker');
    await setAiColor(page, 1);
    await settle(page, 0);
    await page.click('#ai-hint-btn');
    await page.waitForSelector('#ai-hint-explanation');
    assert.match(await page.locator('#ai-hint-explanation').innerText(), /H8.*为什么/);
    assert.match(await page.locator('#ai-hint-explanation').innerText(), /中心/);
    assert.equal(await page.evaluate(() => window.__gomoku.ai.moves.length), 0, '开局提示不落子');
    assert.deepEqual(errors, [], '没有浏览器异常');
    process.stdout.write(`AI E2E 通过: ${url.startsWith('file:') ? '单文件离线' : supportsWorker ? 'HTTP + Worker' : 'Worker 降级'}; 最大主线程间隔 ${Math.round(diagnostic.maxGap)}ms\n`);
  } finally { await context.close(); }
}
/** 故意延迟并重放旧 Worker 响应，验证取消不能仅依赖响应碰巧及时。 */
async function exerciseHintRaces(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('gomoku.ai.playerColor', '1');
    const requests = [];
    const listeners = new Set();
    window.__hintRace = {
      requests,
      release(index) {
        const request = requests[index];
        const y = request.game.board.findIndex(row => row.includes(0));
        const x = request.game.board[y].indexOf(0);
        const event = new MessageEvent('message', { data: {
          t: 'result', id: request.id, move: [x, y],
          stats: { depth: 1, nodes: 1, elapsedMs: 1, bestScore: 0, cutoff: 'depth', fromOpening: false },
        } });
        for (const listener of listeners) listener(event);
      },
    };
    window.Worker = class {
      postMessage(request) { if (request.t === 'search') requests.push(request); }
      addEventListener(type, listener) { if (type === 'message') listeners.add(listener); }
      removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); }
      terminate() { listeners.clear(); }
    };
  });
  const pending = count => page.waitForFunction(n => window.__hintRace.requests.length === n, count);
  const release = index => page.evaluate(i => window.__hintRace.release(i), index);
  const noHint = async () => assert.equal(await page.locator('#ai-hint-marker').count(), 0, '旧响应不能显示提示');
  try {
    await page.goto(BASE);
    if (await page.locator('#lobby-page').count()) await page.locator('#lobby-board-btn').click();
    await page.click('#mode-ai-btn');
    await page.click('#ai-hint-btn');
    await pending(1);
    assert.match(await page.locator('#ai-hint-btn').innerText(), /深入分析/);
    const hintOptions = await page.evaluate(() => window.__hintRace.requests[0].options);
    assert.equal(hintOptions.difficulty, 'hard');
    assert.ok(hintOptions.timeBudgetMs > 3000, '提示有独立的更长分析时间');
    assert.ok(hintOptions.maxNodes > 500000, '提示有独立的更大节点预算');
    await clickCell(page, 7, 7);
    await pending(2);
    const opponentOptions = await page.evaluate(() => window.__hintRace.requests[1].options);
    assert.equal(opponentOptions.timeBudgetMs, undefined, '对手仍使用原档位默认预算');
    await release(0);
    await noHint();
    assert.equal(await page.evaluate(() => window.__gomoku.ai.thinking), true, '旧提示响应不能结束对手思考');
    await release(1);
    await settle(page, 2);

    await page.click('#ai-hint-btn');
    await pending(3);
    await page.click('#undo-btn');
    await release(2);
    await settle(page, 0);
    await noHint();

    await page.click('#ai-hint-btn');
    await pending(4);
    await page.click('#restart-btn');
    await release(3);
    await noHint();
    assert.equal(await page.evaluate(() => window.__gomoku.ai.moves.length), 0, '重开后不落旧子');

    await page.click('#ai-hint-btn');
    await pending(5);
    await page.click('#mode-online-btn');
    await release(4);
    await page.click('#mode-ai-btn');
    await noHint();

    await page.click('#ai-hint-btn');
    await pending(6);
    await setAiColor(page, 2);
    await pending(7);
    await release(5);
    await noHint();
    await release(6);
    await settle(page, 1);

    await page.click('#ai-hint-btn');
    await pending(8);
    await release(7);
    await page.waitForSelector('#ai-hint-explanation');
    await page.click('#ai-hint-btn');
    await pending(9);
    await release(7);
    await noHint();
    assert.equal(await page.locator('#ai-hint-btn').isDisabled(), true, '旧响应不能完成新一轮提示');
    await release(8);
    await page.waitForSelector('#ai-hint-explanation');
    process.stdout.write('AI 提示竞态回归通过：落子、悔棋、重开、切模式、换边、重复请求的过期响应均被忽略\n');
  } finally { await context.close(); }
}
(async () => {
  const browser = await launch();
  try {
    await exerciseHintRaces(browser);
    await exercise(browser, BASE, true);
    await exercise(browser, pathToFileURL(path.resolve('dist/gomoku-standalone.html')).href, true);
    await exercise(browser, BASE, false);
  } finally { await browser.close(); }
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
