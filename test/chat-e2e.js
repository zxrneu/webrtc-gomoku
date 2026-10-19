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
      if (await page.locator('#lobby-page').count()) await page.getByRole('button', { name: /返回棋盘/ }).click();
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

      // 富媒体：能力协商后入口显隐 + 文件消息落地 + 恶意文件名按文本渲染
      await page.evaluate(() => {
        window.__gomoku.deliver({ t: 'hello', name: '对手', capabilities: { qr: true, file: true, audio: false, video: false } });
      });
      await page.locator('#chat-image-btn').waitFor();
      assert.equal(await page.locator('#chat-image-btn').isVisible(), true);
      assert.equal(await page.locator('#chat-file-btn').isVisible(), true);
      assert.equal(await page.locator('#chat-voice-btn').count(), 0);
      await page.evaluate(() => {
        window.__gomoku.deliver({ t: 'media-meta', id: 'e2e-file-1', kind: 'file', name: 'note.txt', size: 5, mime: 'text/plain', chunkSize: 16384, chunks: 1 });
        window.__gomoku.deliver({ t: 'media-chunk', id: 'e2e-file-1', seq: 0, data: 'aGVsbG8=' });
        window.__gomoku.deliver({ t: 'media-end', id: 'e2e-file-1' });
      });
      await page.locator('#chat-list').getByText('note.txt').waitFor();
      assert.equal(await page.locator('#chat-list a[download="note.txt"]').count(), 1);
      await page.evaluate(() => {
        window.__gomoku.deliver({ t: 'media-meta', id: 'e2e-file-2', kind: 'file', name: '<img src=x onerror=alert(1)>.txt', size: 3, mime: 'text/plain', chunkSize: 16384, chunks: 1 });
        window.__gomoku.deliver({ t: 'media-chunk', id: 'e2e-file-2', seq: 0, data: 'YWJj' });
        window.__gomoku.deliver({ t: 'media-end', id: 'e2e-file-2' });
      });
      await page.locator('#chat-list').getByText('<img src=x onerror=alert(1)>.txt').waitFor();
      assert.equal(await page.locator('#chat-list img').count(), 0);

      // SVG 必须降级为下载卡片，严禁 target="_blank" 打开（防同源脚本执行 XSS）
      await page.evaluate(() => {
        window.__gomoku.deliver({ t: 'media-meta', id: 'e2e-svg-xss', kind: 'image', name: 'evil.svg', size: 11, mime: 'image/svg+xml', chunkSize: 16384, chunks: 1 });
        window.__gomoku.deliver({ t: 'media-chunk', id: 'e2e-svg-xss', seq: 0, data: 'PHN2Zz48L3N2Zz4=' });
        window.__gomoku.deliver({ t: 'media-end', id: 'e2e-svg-xss' });
      });
      await page.locator('#chat-list').getByText('evil.svg').waitFor();
      assert.equal(await page.locator('#chat-list a[download="evil.svg"]').count(), 1);
      assert.equal(await page.locator('#chat-list a[target="_blank"]:has(img[alt*="evil.svg"])').count(), 0);

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
      console.log(`  ok - 聊天 Tab、弹出预览、未读、草稿、安全转义、富媒体入口与文件气泡 ${width}px`);
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
