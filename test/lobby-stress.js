'use strict';
// Run only against a disposable test instance: increases test-only per-IP quota.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { LobbyClient, delay, quantiles } = require('./support/lobby-client');
const BASE = process.env.BASE || 'http://127.0.0.1:3114';
const sizes = (process.env.SIZES || '100,500,1000,2000').split(',').map(Number);
const HOLD_MS = Number(process.env.HOLD_MS || 8000);
const OUT = process.env.OUT || 'output/lobby-stress.json';
const PUBLIC_ROOMS = Number(process.env.PUBLIC_ROOMS || 100);
const clients = []; const results = []; let seq = 0; let nextId = 0;
const totalBytes = () => clients.reduce((sum, c) => sum + c.bytes, 0);
async function grow(size) {
  const times = []; const start = performance.now();
  while (clients.length < size) {
    const count = Math.min(20, size - clients.length);
    const startId = nextId; nextId += count;
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const id = startId + index; const t = performance.now();
      const c = await LobbyClient.connect(BASE); clients.push(c);
      const state = await c.enter(id); assert.equal(state.t, 'lobby-state', JSON.stringify(state));
      times.push(performance.now() - t);
    }));
  }
  return { durationMs: +(performance.now() - start).toFixed(1), admissionMs: quantiles(times) };
}
async function measure(label, duration = HOLD_MS) {
  const lags = monitorEventLoopDelay({ resolution: 10 }); lags.enable();
  const rtts = []; const health = []; const errors = []; const timers = [];
  const startBytes = totalBytes(); const start = performance.now();
  let pending = []; let stopped = false;
  const sample = async () => {
    const t = performance.now();
    try { assert.equal((await (await fetch(BASE + '/healthz')).json()).ok, true); health.push(performance.now() - t); }
    catch (e) { errors.push(e.message); }
    const subset = clients.filter(c => !c.closed).filter((_, i) => i % Math.max(1, Math.floor(clients.length / 30)) === 0);
    await Promise.all(subset.map(async c => {
      try { rtts.push(await c.ping(++seq, { t: 'lobby-list', query: '', offset: 0 })); } catch (e) { errors.push(e.message); }
    }));
  };
  // The shipped browser polls once every 5s, staggered here across all sessions.
  for (let i = 0; i < clients.length; i++) {
    timers.push(setTimeout(() => {
      const poll = () => { if (!stopped && !clients[i].closed) clients[i].send({ t: 'lobby-list' }); };
      poll(); timers.push(setInterval(poll, 5000));
    }, i * 5000 / clients.length));
  }
  const sampler = setInterval(() => { pending.push(sample()); }, 1000);
  await sample(); await delay(duration); stopped = true;
  clearInterval(sampler); timers.forEach(clearTimeout); await Promise.all(pending);
  const elapsed = performance.now() - start; lags.disable();
  const bytes = totalBytes() - startBytes;
  const result = { label, clients: clients.length, open: clients.filter(c => !c.closed).length,
    reportedOnline: clients.find(c => !c.closed)?.state?.online,
    durationMs: +elapsed.toFixed(1), queryThenPingMs: quantiles(rtts), healthMs: quantiles(health),
    downstreamBytesPerSec: Math.round(bytes * 1000 / elapsed), downstreamMbps: +(bytes * 8 / elapsed / 1000).toFixed(2),
    generatorLoopP99Ms: +(lags.percentile(99) / 1e6).toFixed(2), errors };
  results.push(result); console.log(JSON.stringify(result)); return result;
}
(async () => {
  try {
    for (const size of sizes) {
      const ramp = await grow(size); console.log(JSON.stringify({ rampTo: size, ...ramp }));
      results.push({ rampTo: size, ...ramp }); await measure(`${size}-users`);
    }
    if (clients.length === 2000) {
      const extra = await LobbyClient.connect(BASE);
      const reply = await extra.enter('overflow');
      results.push({ scenario: '2001st-user', reply }); assert.equal(reply.code, 'LIMIT'); extra.close();
      // Room payload is sent to every lobby client, including the user-list page.
      for (let i = 0; i < PUBLIC_ROOMS; i += 10) await Promise.all(clients.slice(i, i + 10).map(c =>
        c.request({ t: 'lobby-create', public: true }, msg => msg.t === 'lobby-seat')));
      await measure(`2000-users-${PUBLIC_ROOMS}-public-rooms`);
      if (PUBLIC_ROOMS === 1000) {
        const rejected = await clients[1000].request({ t: 'lobby-create', public: true }, msg => msg.t === 'lobby-notice');
        assert.equal(rejected.code, 'LIMIT');
        results.push({ scenario: '1001st-room', code: rejected.code });
        await delay(3100);
        for (let i = 0; i < 1000; i += 10) await Promise.all(clients.slice(1000 + i, 1010 + i).map((c, n) =>
          c.request({ t: 'lobby-join', room: clients[i + n].seat.room }, msg => msg.t === 'lobby-seat')));
        assert.equal(clients.filter(c => c.seat).length, 2000);
        await measure('1000-full-rooms-2000-seats');
      }
      // A refresh / network recovery wave should not freeze the other clients.
      const start = performance.now();
      console.log('Starting 100-disconnect wave');
      const removed = clients.splice(0, 100); removed.forEach(c => c.terminate());
      const observer = clients.at(-1);
      const recovery = await observer.ping(++seq, { t: 'lobby-list' });
      await grow(2000);
      results.push({ scenario: '100-reconnections', observerQueryMs: +recovery.toFixed(1), durationMs: +(performance.now() - start).toFixed(1) });
      await measure('after-100-reconnections');
    }
  } catch (error) {
    results.push({ scenario: 'failure', error: error.message }); throw error;
  } finally {
    const started = performance.now(); clients.forEach(c => c.terminate());
    let health;
    for (let attempt = 0; attempt < 45; attempt++) {
      await delay(1000);
      try {
        const metrics = await (await fetch(BASE + '/metrics')).text();
        if (/gomoku_ws_connections 0(?:\n|$)/.test(metrics)) { health = { disconnectedMs: +(performance.now() - started).toFixed(1) }; break; }
      } catch {}
    }
    results.push({ scenario: 'disconnect-cleanup', ...health });
    fs.mkdirSync(require('node:path').dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ base: BASE, results }, null, 2) + '\n');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
