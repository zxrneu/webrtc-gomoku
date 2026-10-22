/** Compare the actual production search with TS and Rust/WASM scoring. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { applyMove, create, currentColor, createWasmSearchSession } from '../packages/core/dist/index.mjs';

const args = new Map(process.argv.slice(2).map((value) => value.replace(/^--/, '').split('=')));
const timeBudgetMs = Number(args.get('budget') ?? 1000);
const nodeBudget = Number(args.get('nodes') ?? 8000);
if (![timeBudgetMs, nodeBudget].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('budgets must be positive integers');
const output = path.resolve(args.get('output') ?? 'output/playwright/wasm-production-benchmark.json');
const opening = [[7, 7], [8, 7], [6, 6], [9, 8], [6, 8], [7, 9]];
const fixtures = [
  { name: 'balanced-6', moves: opening },
  { name: 'balanced-8', moves: [...opening, [5, 8], [8, 9]] },
  { name: 'balanced-10', moves: [...opening, [5, 8], [8, 9], [4, 9], [9, 9]] },
  { name: 'scattered-12', moves: [[7, 7], [9, 7], [6, 5], [8, 9], [5, 8], [10, 6], [9, 10], [4, 6], [8, 4], [5, 10], [10, 9], [3, 8]] },
  { name: 'unique-block', moves: [[5, 7], [4, 7], [6, 7], [0, 0], [7, 7], [0, 2], [8, 7]] },
  { name: 'double-three', moves: [[5, 7], [0, 0], [6, 7], [0, 2], [7, 5], [14, 14], [7, 6], [14, 12]] },
];

function game(moves) {
  const value = create();
  for (const [x, y] of moves) assert.equal(applyMove(value, x, y, currentColor(value)).ok, true);
  return value;
}
function measure(fixture, backend, options) {
  const input = game(fixture.moves);
  const before = JSON.stringify(input);
  const started = performance.now();
  const session = createWasmSearchSession(input, currentColor(input), { ...options, backend });
  while (session.step(32)) { /* Preserve the same incremental production search. */ }
  const wallMs = performance.now() - started;
  const stats = session.stats();
  assert.equal(stats.backend, backend);
  assert.equal(JSON.stringify(input), before);
  const move = session.result();
  assert.ok(move && input.board[move[1]][move[0]] === 0);
  return { move, ...stats, winningProof: undefined, wallMs, nps: stats.nodes / (wallMs / 1000) };
}
function pair(fixture, options, order) {
  const results = {};
  for (const backend of order) results[backend] = measure(fixture, backend, options);
  return { name: fixture.name, ts: results.ts, wasm: results['rust-wasm'] };
}

const common = { difficulty: 'hard', maxDepth: 12, maxNodes: nodeBudget, vcfMaxNodes: 512, pnsMaxNodes: 1024 };
for (const backend of ['ts', 'rust-wasm']) measure(fixtures[0], backend, { ...common, maxNodes: 100 });
const fixed = [];
for (let round = 0; round < 3; round += 1) {
  for (const fixture of fixtures) {
    const value = pair(fixture, common, round % 2 ? ['rust-wasm', 'ts'] : ['ts', 'rust-wasm']);
    for (const key of ['move', 'nodes', 'depth', 'bestScore', 'proofStatus', 'cutoff']) assert.deepEqual(value.ts[key], value.wasm[key], `${fixture.name}/${key}`);
    fixed.push({ round, ...value });
  }
}
const timed = fixtures.slice(0, 4).map((fixture, index) => pair(fixture, {
  difficulty: 'hard', maxNodes: 500000, maxDepth: 16, timeBudgetMs, now: () => performance.now(),
}, index % 2 ? ['rust-wasm', 'ts'] : ['ts', 'rust-wasm']));
const sum = (rows, backend, key) => rows.reduce((total, row) => total + row[backend][key], 0);
const summary = {
  fixedPairs: fixed.length, fixedDiscrepancies: 0,
  fixedWallRatioTsOverWasm: sum(fixed, 'ts', 'wallMs') / sum(fixed, 'wasm', 'wallMs'),
  timedPositions: timed.length, timeBudgetMs,
  timedNodesRatioWasmOverTs: sum(timed, 'wasm', 'nodes') / sum(timed, 'ts', 'nodes'),
  timedSameMoves: timed.filter((row) => JSON.stringify(row.ts.move) === JSON.stringify(row.wasm.move)).length,
};
const document = { generatedAt: new Date().toISOString(), platform: `${process.version} ${process.platform}/${process.arch}`,
  scope: 'Same production TS search; only incremental and hypothetical scoring use Rust/WASM. No playing-strength claim.', summary, fixed, timed };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(document, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary) + '\n');
