'use strict';
// Independent process: receives no roster broadcasts, so load-driver parsing
// cannot inflate its socket/HTTP latency measurements.
const fs = require('node:fs');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { LobbyClient, delay, quantiles } = require('./support/lobby-client');
const BASE = process.env.BASE || 'http://127.0.0.1:3114';
const DURATION = Number(process.env.DURATION_MS || 60000);
const OUT = process.env.OUT || 'output/lobby-independent-probe.json';
(async () => {
  const c = await LobbyClient.connect(BASE); const start = performance.now();
  const samples = []; let seq = 500000; const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  try {
    while (performance.now() - start < DURATION) {
      const t = performance.now(); let queryMs; let healthMs; let error;
      await Promise.all([
        c.ping(++seq, { t: 'lobby-list' }, 60000).then(ms => { queryMs = ms; }).catch(e => { error = e.message; }),
        (async () => { const h = performance.now(); await (await fetch(BASE + '/healthz')).json(); healthMs = performance.now() - h; })(),
      ]);
      samples.push({ atMs: Math.round(t - start), queryMs, healthMs, error });
      await delay(500);
    }
  } finally {
    c.terminate(); loop.disable();
    const result = { base: BASE, queryMs: quantiles(samples.flatMap(s => s.queryMs === undefined ? [] : [s.queryMs])),
      healthMs: quantiles(samples.map(s => s.healthMs)), loopP99Ms: +(loop.percentile(99) / 1e6).toFixed(2), samples };
    fs.mkdirSync(require('node:path').dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, samples: undefined }));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
