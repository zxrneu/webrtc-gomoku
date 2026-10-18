'use strict';

// 真实双浏览器回归：P2P 单独失效、同步棋谱后再次断线、恢复后继续落子。
// 先启动构建后的服务器，再运行 BASE=http://localhost:3000 node test/reconnect-regression-e2e.js。
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';

async function newPlayer(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(() => {
    // 注入故障的入口只存在于测试页面，不向产品添加写探针。
    window.__testSockets = [];
    window.__testChannels = [];
    window.__testSyncs = 0;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__testSockets.push(this);
      }
    };
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(...args) {
        super(...args);
        this.addEventListener('datachannel', ({ channel }) => {
          channel.addEventListener('message', ({ data }) => {
            if (JSON.parse(data).t === 'sync') window.__testSyncs++;
          });
        });
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        window.__testChannels.push(channel);
        return channel;
      }
    };
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => Boolean(window.__gomoku));
  return { context, page };
}

async function waitConnected(page) {
  await page.waitForFunction(
    () => window.__gomoku.connState === 'CONNECTED' && window.__gomoku.dcState === 'open',
    null,
    { timeout: 30000 }
  );
}

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
  });
  try {
    const host = await newPlayer(browser);
    const guest = await newPlayer(browser);
    await host.page.click('#create-room-btn');
    await host.page.waitForFunction(() => Boolean(window.__gomoku.room));
    const room = await host.page.evaluate(() => window.__gomoku.room);
    await guest.page.fill('#room-input', room);
    await guest.page.click('#join-room-btn');
    await Promise.all([waitConnected(host.page), waitConnected(guest.page)]);
    await host.page.click('#board', { position: { x: 28 + 7 * 36, y: 28 + 7 * 36 } });
    await guest.page.waitForFunction(() => window.__gomoku.moves.length === 1);

    await host.page.evaluate(() => window.__testChannels.at(-1).close());
    await host.page.waitForFunction(() => window.__gomoku.connState === 'P2P_RECOVERING');
    await Promise.all([waitConnected(host.page), waitConnected(guest.page)]);
    await guest.page.waitForFunction(() => window.__testSyncs > 0);
    assert.equal(await guest.page.evaluate(() => window.__gomoku.moves.length), 1);
    console.log('ok - 仅 P2P 失效后自动重建、对账并保留棋谱');

    await guest.context.setOffline(true);
    await guest.page.evaluate(() => window.__testSockets.at(-1).close());
    await guest.page.waitForFunction(() => window.__gomoku.connState === 'RECONNECTING');
    assert.equal(await guest.page.evaluate(() => window.__gomoku.connected), false,
      '棋谱同步后再次断线，界面必须停止显示已连接');
    assert.equal(await guest.page.locator('#board-overlay').isVisible(), true);
    console.log('ok - 棋谱同步后再次断线会锁盘并显示断线状态');

    await guest.context.setOffline(false);
    await guest.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await Promise.all([waitConnected(host.page), waitConnected(guest.page)]);
    await guest.page.click('#board', { position: { x: 28 + 8 * 36, y: 28 + 7 * 36 } });
    await host.page.waitForFunction(() => window.__gomoku.moves.length === 2);
    assert.deepEqual(
      await host.page.evaluate(() => window.__gomoku.moves),
      await guest.page.evaluate(() => window.__gomoku.moves)
    );
    console.log('ok - 再次恢复后能继续落子且双方棋谱一致');

    const waitingHost = await newPlayer(browser);
    const lateGuest = await newPlayer(browser);
    await waitingHost.page.click('#create-room-btn');
    await waitingHost.page.waitForFunction(() => window.__gomoku.connState === 'ROOM_WAITING');
    const waitingRoom = await waitingHost.page.evaluate(() => window.__gomoku.room);
    await waitingHost.context.setOffline(true);
    await waitingHost.page.evaluate(() => window.__testSockets.at(-1).close());
    await waitingHost.page.waitForFunction(() => window.__gomoku.connState === 'RECONNECTING');
    await lateGuest.page.fill('#room-input', waitingRoom);
    await lateGuest.page.click('#join-room-btn');
    await lateGuest.page.waitForFunction(() => window.__gomoku.connState === 'ROOM_WAITING');
    await waitingHost.context.setOffline(false);
    await waitingHost.page.evaluate(() => window.dispatchEvent(new Event('online')));

    await Promise.all([waitConnected(waitingHost.page), waitConnected(lateGuest.page)]);
    console.log('ok - 房主离线时对手加入，房主恢复后双方能自动建立直连');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
