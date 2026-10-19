'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { LobbyClient, delay } = require('./support/lobby-client');
const BASE = process.env.BASE || 'http://127.0.0.1:3115';
const OUT = process.env.OUT || 'output/lobby-protocol.json';
const outcomes = []; let nextId = 30000; let active = [];
const isState = m => m.t === 'lobby-state';
const isResult = m => m.t === 'lobby-state' || m.t === 'lobby-notice';
async function client(enter = true, identity = {}) {
  const c = await LobbyClient.connect(BASE); active.push(c);
  if (enter) assert.equal((await c.enter(nextId++, identity)).t, 'lobby-state');
  return c;
}
async function scenario(name, fn) {
  try { const detail = await fn(); outcomes.push({ name, passed: true, detail }); console.log('PASS', name, detail || ''); }
  catch (e) { outcomes.push({ name, passed: false, error: e.message }); console.log('FAIL', name, e.message); }
  finally {
    for (const c of active) { if (!c.closed) { c.send({ t: 'leave' }); c.close(); } }
    active = []; await delay(150);
  }
}
(async () => {
  await scenario('非法昵称和参数拒绝后，连接仍可正常使用', async () => {
    const c = await client(false);
    const invalid = await c.enter(nextId++, { name: '<script>' });
    assert.ok(invalid.t === 'lobby-notice');
    assert.equal((await c.enter(nextId++)).t, 'lobby-state');
    const before = c.state.name;
    await c.request({ t: 'lobby-name', name: 'a\u0345' }, m => m.t === 'lobby-notice');
    assert.equal((await c.request({ t: 'lobby-list' }, isState)).name, before);
    c.send('{bad json'); await c.ping(10001);
  });
  await scenario('只看可邀请会排除手动会话忙碌用户', async () => {
    const a = await client(); const b = await client();
    await b.request({ t: 'lobby-ready', ready: true }, isState);
    const filtered = await a.request({ t: 'lobby-list', onlyAvailable: true }, isState);
    assert.ok(filtered.users.every(u => u.id !== b.state.selfId));
  });
  await scenario('浏览器第3窗口拒绝，关闭旧窗口后可再次进入', async () => {
    const browserId = `quota-${nextId++}`;
    const a = await client(true, { browserId }); await client(true, { browserId });
    const c = await client(false);
    assert.equal((await c.enter(nextId++, { browserId })).code, 'SESSION_LIMIT');
    a.close(); await delay(200);
    assert.equal((await c.enter(nextId++, { browserId })).t, 'lobby-state');
  });
  await scenario('邀请取消后迟到的接受不能建房', async () => {
    const a = await client(); const b = await client();
    const invitation = await a.request({ t: 'lobby-invite', target: b.state.selfId }, m => isState(m) && m.invite);
    await a.request({ t: 'lobby-cancel', id: invitation.invite.id }, m => isState(m) && !m.invite);
    const reply = await b.request({ t: 'lobby-respond', id: invitation.invite.id, accept: true }, isState);
    assert.equal(reply.room, null); assert.equal(b.seat, null);
  });
  await scenario('邀请双方交叉邀请和重复接受只创建一桌', async () => {
    const a = await client(); const b = await client();
    const invitation = await a.request({ t: 'lobby-invite', target: b.state.selfId }, m => isState(m) && m.invite);
    await b.request({ t: 'lobby-invite', target: a.state.selfId }, isResult);
    const aSeat = a.wait(m => m.t === 'lobby-seat');
    const bSeat = await b.request({ t: 'lobby-respond', id: invitation.invite.id, accept: true }, m => m.t === 'lobby-seat');
    assert.equal((await aSeat).room, bSeat.room);
    b.send({ t: 'lobby-respond', id: invitation.invite.id, accept: true });
    const state = await b.request({ t: 'lobby-list' }, isState);
    assert.equal(state.room.code, bSeat.room);
  });
  await scenario('两名棋友同时加入仅剩1座的房间，只能1人成功', async () => {
    const host = await client(); const a = await client(); const b = await client();
    const seat = await host.request({ t: 'lobby-create', public: true }, m => m.t === 'lobby-seat');
    const result = await Promise.all([a, b].map(c => c.request({ t: 'lobby-join', room: seat.room },
      m => m.t === 'lobby-seat' || m.t === 'lobby-notice')));
    assert.equal(result.filter(m => m.t === 'lobby-seat').length, 1);
    assert.equal(result.find(m => m.t === 'lobby-notice').code, 'ROOM_FULL');
  });
  await scenario('非房主不能切换公开状态，私密房不能从大厅加入', async () => {
    const a = await client(); const b = await client();
    const seat = await a.request({ t: 'lobby-create', public: false }, m => m.t === 'lobby-seat');
    await b.request({ t: 'lobby-visibility', public: true }, isState);
    const reply = await b.request({ t: 'lobby-join', room: seat.room }, m => m.t === 'lobby-notice');
    assert.equal(reply.code, 'ROOM_NOT_FOUND');
  });
  await scenario('单连接突发100次大厅操作应被限频', async () => {
    const a = await client();
    for (let i = 0; i < 100; i++) a.send({ t: 'lobby-list' });
    await a.ping(10002);
    assert.ok(a.notices.some(m => m.code === 'RATE_LIMITED'), '100 次请求全部处理，没有 RATE_LIMITED');
  });
  await scenario('座位接管后，旧连接不能 leave 或重新夺座', async () => {
    const old = await client(false); const fresh = await client(false);
    const room = (nextId++).toString(36).toUpperCase().padStart(4, '0');
    const seat = await old.request({ t: 'create', room }, m => m.t === 'created');
    const resumed = await fresh.request({ t: 'resume', room: seat.room, peerId: seat.peerId, token: seat.token },
      m => m.t === 'resumed' || m.t === 'error');
    assert.equal(resumed.t, 'resumed');
    await old.ping(10003, { t: 'leave' });
    const verify = await client(false);
    const reply = await verify.request({ t: 'resume', room: seat.room, peerId: seat.peerId, token: resumed.token },
      m => m.t === 'resumed' || m.t === 'error');
    assert.equal(reply.t, 'resumed', '旧连接 leave 导致新连接座位被销毁');
  });
  if (process.env.LONG_TESTS === '1') {
    await scenario('邀请30秒过期，匹配60秒超时且不建房', async () => {
      const a = await client(); const b = await client(); const queued = await client();
      const start = performance.now();
      const inviteExpired = a.wait(m => m.t === 'lobby-notice' && m.code === 'EXPIRED', 35000);
      const matchExpired = queued.wait(m => m.t === 'lobby-notice' && m.code === 'MATCH_TIMEOUT', 65000);
      await a.request({ t: 'lobby-invite', target: b.state.selfId }, m => isState(m) && m.invite);
      await queued.request({ t: 'lobby-match', action: 'join' }, m => isState(m) && m.match);
      await inviteExpired; const inviteMs = performance.now() - start;
      await matchExpired; const matchMs = performance.now() - start;
      assert.equal((await queued.request({ t: 'lobby-list' }, isState)).room, null);
      return { inviteMs: Math.round(inviteMs), matchMs: Math.round(matchMs) };
    });
  }
  fs.mkdirSync(require('node:path').dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ base: BASE, outcomes }, null, 2) + '\n');
  if (outcomes.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
