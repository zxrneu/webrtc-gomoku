'use strict';
/** 真实 Worker、单文件离线、取消恢复与不支持 Worker 时的浏览器回归。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';

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
    await page.waitForFunction(() => !!window.__gomoku);
    await context.setOffline(true);
    const beforeRequests = requests.length;
    await page.click('#mode-ai-btn');
    await settle(page, 1);
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

    await clickCell(page, 0, 14);
    await page.waitForFunction(() => window.__gomoku.ai.thinking);
    assert.equal(await page.locator('#restart-btn').isDisabled(), true);
    await page.click('#mode-online-btn');
    const cancelledMoves = await page.evaluate(() => window.__gomoku.ai.moves.length);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__gomoku.ai.moves.length), cancelledMoves, '取消后不落旧子');
    await page.click('#mode-ai-btn');
    await settle(page, 5);
    await page.click('#ai-restart-btn');
    await settle(page, 1);
    await page.click('#ai-color-white-btn');
    await page.click('#ai-color-white-btn');
    await settle(page, 1);
    assert.equal(await page.evaluate(() => window.__aiWorkerTest.created), supportsWorker ? 1 : 0, '重开仍复用 Worker');
    assert.deepEqual(errors, [], '没有浏览器异常');
    process.stdout.write(`AI E2E 通过: ${url.startsWith('file:') ? '单文件离线' : supportsWorker ? 'HTTP + Worker' : 'Worker 降级'}; 最大主线程间隔 ${Math.round(diagnostic.maxGap)}ms\n`);
  } finally { await context.close(); }
}
(async () => {
  const browser = await launch();
  try {
    await exercise(browser, BASE, true);
    await exercise(browser, pathToFileURL(path.resolve('dist/gomoku-standalone.html')).href, true);
    await exercise(browser, BASE, false);
  } finally { await browser.close(); }
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
