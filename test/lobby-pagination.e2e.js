'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    let socket; let offset = 0; let revision = 0;
    let users = Array.from({ length: 26 }, (_, n) => ({ id: `user-${n}`, name: `棋友${n}`, status: 'idle' }));
    const snapshot = () => ({ t: 'lobby-state', selfId: 'self', name: '查看棋友', online: users.length + 1, waiting: 0,
      users: users.slice(offset, offset + 20), totalUsers: users.length, rooms: [], totalRooms: 0,
      room: null, invite: null, match: null, serverNow: Date.now(), revision: ++revision });
    await page.routeWebSocket('**/signal', ws => {
      socket = ws;
      ws.onMessage(raw => {
        const m = JSON.parse(raw);
        if (m.t === 'lobby-list') offset = m.offset || 0;
        if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: m.ts }));
        else ws.send(JSON.stringify(snapshot()));
      });
    });
    await page.goto(`${BASE}/lobby`);
    await page.getByRole('button', { name: /加载更多棋友|下一页/ }).click();
    await page.getByText('棋友25', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '320px 分页控件不可产生横向溢出');
    users = users.filter(u => u.id !== 'user-0');
    socket.send(JSON.stringify(snapshot()));
    await page.waitForFunction(() => document.querySelector('#lobby-panel').textContent.includes('在线 26'));
    assert.equal(await page.getByText('棋友0', { exact: true }).count(), 0, '离线用户不可保留为可邀请的前页缓存');
    await page.getByRole('button', { name: '上一页' }).click();
    await page.getByText('棋友1', { exact: true }).waitFor();
    assert.equal(await page.getByText('棋友0', { exact: true }).count(), 0);
    console.log('ok - 分页只显示实时名册，翻页后离线棋友不会残留');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
