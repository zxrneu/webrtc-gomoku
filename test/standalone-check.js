'use strict';
/* 单文件版验证：file:// 打开 → 页面渲染 → 手动信令生成邀请码 */
const path = require('path');
const { chromium } = require('playwright');

const FILE = 'file://' + path.join(__dirname, '..', 'dist', 'gomoku-standalone.html');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(FILE);

  const r = await page.evaluate(async () => {
    const out = {};
    out.title = document.title;
    out.canvas = !!document.getElementById('board');
    out.canvasW = document.getElementById('board').width;
    out.fileTip = document.getElementById('file-tip').style.display;
    document.querySelector('.tab[data-tab="manual"]').click();
    out.manualVisible = !document.getElementById('tab-manual').classList.contains('hidden');
    document.getElementById('manual-host-btn').click();
    await new Promise((res) => setTimeout(res, 6000));
    out.outWrapVisible = !document.getElementById('manual-out-wrap').classList.contains('hidden');
    const code = document.getElementById('manual-out').value;
    out.codeLen = code.length;
    out.codeHead = code.slice(0, 6);
    out.hookOk = !!window.__gomoku;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));

  await page.screenshot({ path: path.join(__dirname, 'standalone-manual.png') });
  await browser.close();

  const ok =
    r.canvas && r.canvasW === 560 && r.fileTip === 'block' && r.manualVisible &&
    r.outWrapVisible && r.codeLen > 50 && r.hookOk;
  console.log(ok ? 'STANDALONE CHECK PASS' : 'STANDALONE CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
