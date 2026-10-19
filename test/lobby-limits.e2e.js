'use strict';
const assert = require('node:assert/strict');
const { LobbyClient, delay } = require('./support/lobby-client');
const BASE = process.env.BASE || 'http://127.0.0.1:3115';
const LIMIT = Number(process.env.IP_LIMIT || 100);
(async () => {
  const clients = [];
  try {
    while (clients.length < LIMIT) {
      const batch = await Promise.all(Array.from({ length: Math.min(10, LIMIT - clients.length) }, () => LobbyClient.connect(BASE)));
      clients.push(...batch);
    }
    let extra;
    try {
      extra = await LobbyClient.connect(BASE); clients.push(extra); await delay(200);
      assert.equal(extra.closed, true, '超过单IP配额的新连接不应继续存活');
      assert.equal(extra.closeCode, 1008);
    } catch (error) { assert.match(error.message, /HTTP 503/); }
    clients[0].close(); await delay(200);
    const replacement = await LobbyClient.connect(BASE); clients.push(replacement);
    await replacement.ping(90001);
    console.log(`PASS 单IP ${LIMIT} 条连接上限，以及断开后的配额释放`);
  } finally { clients.forEach(c => c.terminate()); }
})().catch(e => { console.error(e); process.exitCode = 1; });
