/** Reproducible differential verification and production-engine measurements. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  create, applyMove, undo, currentColor, createSearchSession,
  pointScore, patternOfWindow, PATTERN_SCORES,
} from '../packages/core/dist/index.mjs';
import { createKernel, searchFixedDepth } from '../packages/core/src/ai/wasm/kernel.ts';
import { renderDifferentialReport, verificationStatus } from './lib/differential-report.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')));
const positions = Number(args.get('positions') ?? 10);
const budgetMs = Number(args.get('budget') ?? 3000);
if (!Number.isInteger(positions) || positions < 1 || positions > 100 || !Number.isFinite(budgetMs) || budgetMs <= 0) {
  throw new Error('Expected --positions=1..100 and a positive --budget in milliseconds');
}
const wasm = createKernel();
const ts = createKernel({ forceTs: true });
if (!wasm.isWasm) throw new Error('A real WASM kernel is required for differential verification');

function generatePosition(seed, stones) {
  const game = create();
  let state = seed;
  for (let attempts = 0; game.moves.length < stones && attempts < 10000; attempts += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const x = 3 + state % 9;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const y = 3 + state % 9;
    const move = applyMove(game, x, y, currentColor(game));
    if (move.ok && game.over) undo(game);
  }
  if (game.moves.length !== stones) throw new Error('Unable to generate requested legal position');
  return game;
}
function measure(kernel, board, color, depth) {
  kernel.setBoard(board);
  const start = performance.now();
  const result = searchFixedDepth(kernel, color, depth, 6, 20000);
  return { ...result, elapsedMs: performance.now() - start };
}

const tiers = [];
let discrepancies = 0;
for (let code = 0; code < 19683; code += 1) {
  let rest = code;
  const digits = [];
  for (let i = 0; i < 9; i += 1) { digits.push(rest % 3); rest = Math.floor(rest / 3); }
  const expected = digits[4] === 1 ? PATTERN_SCORES[patternOfWindow(digits.join(''))] : 0;
  if (wasm.rawWindowScore(code) !== expected) discrepancies += 1;
}
tiers.push({ name: '棋型真值表', samples: 19683, discrepancies });

const games = Array.from({ length: positions }, (_, i) => generatePosition(7 + i * 31, 8 + i % 15));
let pointSamples = 0;
discrepancies = 0;
for (const game of [create(), ...games]) {
  const board = Int8Array.from(game.board.flat());
  wasm.setBoard(board);
  for (const color of [1, 2]) {
    for (let at = 0; at < 225; at += 1) {
      pointSamples += 1;
      if (wasm.pointScore(at, color) !== pointScore(board, at, color)) discrepancies += 1;
    }
  }
}
tiers.push({ name: '全盘点分（空盘与合法中局，黑白双方）', samples: pointSamples, discrepancies });

let tacticalSamples = 0;
discrepancies = 0;
for (const forceTs of [true, false]) {
  const kernel = createKernel({ forceTs });
  const closedThree = new Int8Array(225);
  for (const at of [109, 110, 111]) closedThree[at] = 1;
  for (const at of [108, 0, 224]) closedThree[at] = 2;
  kernel.setBoard(closedThree);
  if (Math.abs(searchFixedDepth(kernel, 1, 2).bestScore) >= 9_000_000) discrepancies += 1;
  tacticalSamples += 1;
  closedThree[112] = 1;
  kernel.setBoard(closedThree);
  const block = searchFixedDepth(kernel, 2, 1);
  if (block.bestMove !== 113 || block.bestScore <= -9_000_000) discrepancies += 1;
  tacticalSamples += 1;
  closedThree[108] = 0;
  kernel.setBoard(closedThree);
  if (searchFixedDepth(kernel, 2, 2).bestScore > -9_000_000) discrepancies += 1;
  tacticalSamples += 1;
}
tiers.push({ name: '独立战术断言（可防冲四、唯一堵点、双成五）', samples: tacticalSamples, discrepancies });

const comparisons = [];
for (let i = 0; i < games.length; i += 1) {
  const board = Int8Array.from(games[i].board.flat());
  for (const color of [1, 2]) {
    for (const depth of [2, 4]) {
      comparisons.push({ name: `position-${i + 1}/color-${color}`, depth,
        ts: measure(ts, board, color, depth), wasm: measure(wasm, board, color, depth) });
    }
  }
}

const production = [];
let illegalMoves = 0;
for (let i = 0; i < games.length; i += 1) {
  const game = games[i];
  const session = createSearchSession(game, currentColor(game), { difficulty: 'hard', timeBudgetMs: budgetMs, now: () => performance.now() });
  const start = performance.now();
  while (session.step(32)) { /* CLI drives the real resumable production engine. */ }
  const elapsedMs = performance.now() - start;
  const move = session.result();
  if (!move || game.board[move[1]]?.[move[0]] !== 0) illegalMoves += 1;
  const stats = session.stats();
  production.push({ name: `position-${i + 1}`, move, depth: stats.depth, nodes: stats.nodes, elapsedMs, cutoff: stats.cutoff, budgetMs });
  process.stdout.write(`production ${i + 1}/${games.length}: ${elapsedMs.toFixed(1)}ms, ${stats.nodes} nodes\n`);
}
tiers.push({ name: '生产 TS 合法落子', samples: production.length, discrepancies: illegalMoves });

const data = { generatedAt: new Date().toISOString(), platform: `${process.version} ${process.platform}/${process.arch}`,
  tiers, comparisons, production };
const output = path.resolve(args.get('output') ?? path.join(root, 'docs/m5-ai/differential-benchmark-report.md'));
fs.writeFileSync(output, renderDifferentialReport(data));
fs.writeFileSync(output.replace(/\.md$/, '') + '.json', JSON.stringify(data, null, 2) + '\n');
const status = verificationStatus(tiers, comparisons);
process.stdout.write(`Differential verification ${status.passed ? 'PASS' : 'FAIL'}: ${output}\n`);
if (!status.passed) process.exitCode = 1;
