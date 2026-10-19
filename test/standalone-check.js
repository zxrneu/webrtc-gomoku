'use strict';
// file:// 单文件回归：通过真实表单事件完成手动信令和 P2P，不直接修改 React 受控输入。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const FILE = 'file://' + path.join(__dirname, '..', 'dist', 'gomoku-standalone.html');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  try {
    const pages = [];
    for (const name of ['邀请人', '被邀请人']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(FILE); await page.waitForFunction(() => !!window.__gomoku);
      assert.equal(await page.locator('#lobby-page').count(), 0);
      assert.equal(await page.locator('[data-online-tab="lobby"]').count(), 0);
      assert.equal(await page.locator('#create-room-btn').isDisabled(), true);
      assert.equal(await page.locator('#join-room-btn').isDisabled(), true);
      await page.locator('.tab[data-tab="manual"]').click();
      await page.locator('#name-input').fill(name); pages.push(page);
    }
    const [host, guest] = pages;
    await host.locator('#flow-host-btn').click();
    await host.waitForFunction(() => document.getElementById('flow-host-out').value.length > 50);
    const offer = await host.locator('#flow-host-out').inputValue();
    await guest.locator('#flow-guest-btn').click();
    await guest.locator('#flow-guest-in').fill(offer); await guest.locator('#flow-guest-answer').click();
    await guest.waitForFunction(() => document.getElementById('flow-guest-out').value.length > 50);
    const answer = await guest.locator('#flow-guest-out').inputValue();
    await host.locator('#flow-host-in').fill(answer); await host.locator('#flow-host-finish').click();
    for (const page of pages) await page.waitForFunction(() => window.__gomoku.connected, null, { timeout: 20000 });
    assert.equal(await host.evaluate(() => window.__gomoku.dcState), 'open');
    console.log('ok - 单文件没有大厅，房间入口禁用，手动信令真实 P2P 双向连通');
    await host.setViewportSize({ width: 375, height: 900 });
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    fs.mkdirSync('output/playwright', { recursive: true });
    await host.screenshot({ path: 'output/playwright/standalone-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('ok - 单文件移动端无溢出、无页面错误');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
