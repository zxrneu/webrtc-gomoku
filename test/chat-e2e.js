'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  try {
    for (const width of [1440, 1024, 768, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(BASE);
      await page.waitForFunction(() => !!window.__gomoku);
      const gameTab = page.getByRole('tab', { name: '对局', exact: true });
      const chatTab = page.getByRole('tab', { name: /聊天/ });
      await gameTab.waitFor({ timeout: 3000 });
      await gameTab.focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat-tab');
      await page.keyboard.press('Home');
      assert.equal(await gameTab.getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#chat-input').isVisible(), false);
      await page.evaluate(() => {
        window.__gomoku.forceConnected(true);
        window.__gomoku.deliver({ t: 'chat', text: '这步下得不错！' });
        window.__gomoku.deliver({ t: 'chat', text: '<img src=x onerror=alert(1)>' });
      });
      const launcher = page.getByRole('button', { name: '打开聊天，2 条未读消息' });
      await launcher.waitFor();
      assert.equal(await page.locator('#chat-preview img').count(), 0);
      await page.locator('#chat-preview').click();
      assert.equal(await chatTab.getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#chat-input').isVisible(), true);
      assert.equal(await page.locator('#chat-preview').count(), 0);
      await page.locator('#chat-input').fill('下一步到你了');
      await page.locator('#chat-send-btn').click();
      assert.match(await page.locator('#chat-list .mine').innerText(), /下一步到你了/);
      await page.evaluate(() => window.__gomoku.deliver({ t: 'chat', text: '收到' }));
      assert.equal(await page.locator('#chat-preview').count(), 0);
      await page.locator('#chat-input').fill('保留草稿');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat-launcher');
      await page.getByRole('button', { name: '打开聊天', exact: true }).click();
      assert.equal(await page.locator('#chat-input').inputValue(), '保留草稿');
      assert.equal(await page.locator('#chat-preview').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const inputBox = await page.locator('#chat-input').boundingBox();
      assert.ok(inputBox.x >= 0 && inputBox.y + inputBox.height <= 900);
      await page.screenshot({ path: `test/chat-${width}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__gomoku.deliver({ t: 'chat', text: '再来一局？' }));
      await page.locator('#chat-preview').waitFor();
      await page.locator('#chat-preview').waitFor({ state: 'detached', timeout: 7000 });
      await page.getByRole('button', { name: '打开聊天，1 条未读消息' }).waitFor();
      await page.evaluate(() => window.__gomoku.setMode('ai'));
      assert.equal(await page.locator('#chat-launcher').count(), 0);
      await page.close();
      console.log(`  ok - 聊天 Tab、弹出预览、未读、草稿、安全转义 ${width}px`);
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
