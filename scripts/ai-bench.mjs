/**
 * AI 性能与棋力观测基准台架 (P0-1)
 *
 * 用法:
 *   node scripts/ai-bench.mjs [--positions=5] [--seed=7] [--budget=3000] [--json] [--difficulty=hard]
 */

import { performance } from 'node:perf_hooks';
import {
  create,
  applyMove,
  currentColor,
  createSearchSession,
  BLACK,
  WHITE,
} from '../packages/core/dist/index.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 用确定性伪随机数生成一个指定手数的未终局局面
 */
export function generatePosition(seed, moveCount = 20) {
  const rand = mulberry32(seed);
  const game = create();

  // 第一步落在天元或附近
  const centerOffsets = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const firstOffset = centerOffsets[Math.floor(rand() * centerOffsets.length)];
  applyMove(game, 7 + firstOffset[0], 7 + firstOffset[1], BLACK);

  let placed = 1;
  let attempts = 0;
  while (placed < moveCount && attempts < 1000) {
    attempts += 1;
    const color = currentColor(game);
    // 从已有棋子的切比雪夫 1~2 范围内找空格，保持局面紧凑连贯
    const neighbors = [];
    const occupied = new Set(game.moves.map((m) => `${m.x},${m.y}`));

    for (const m of game.moves) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = m.x + dx;
          const ny = m.y + dy;
          if (nx >= 0 && nx < 15 && ny >= 0 && ny < 15) {
            const key = `${nx},${ny}`;
            if (!occupied.has(key)) {
              neighbors.push([nx, ny]);
              occupied.add(key); // 避免重复入池
            }
          }
        }
      }
    }

    if (neighbors.length === 0) break;
    // 随机挑一个邻居落子
    const pick = neighbors[Math.floor(rand() * neighbors.length)];
    const res = applyMove(game, pick[0], pick[1], color);
    if (res.ok) {
      if (game.over) {
        // 如果过早成五，撤销并换一个点
        game.moves.pop();
        game.board[pick[1]][pick[0]] = 0;
        game.over = false;
        game.winLine = null;
        continue;
      }
      placed += 1;
    }
  }

  return game;
}

function parseArgs() {
  const args = {
    positions: 5,
    seed: 7,
    budget: 3000,
    difficulty: 'hard',
    json: false,
    maxDepth: undefined,
    maxNodes: undefined,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (arg.startsWith('--positions=')) args.positions = parseInt(arg.slice(12), 10);
    else if (arg.startsWith('--seed=')) args.seed = parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--budget=')) args.budget = parseInt(arg.slice(9), 10);
    else if (arg.startsWith('--difficulty=')) args.difficulty = arg.slice(13);
    else if (arg.startsWith('--maxDepth=')) args.maxDepth = parseInt(arg.slice(11), 10);
    else if (arg.startsWith('--maxNodes=')) args.maxNodes = parseInt(arg.slice(11), 10);
  }
  return args;
}

async function runBench() {
  const opts = parseArgs();
  const results = [];

  for (let i = 0; i < opts.positions; i += 1) {
    const seed = opts.seed + i * 31;
    const game = generatePosition(seed, 20);
    const color = currentColor(game);

    const now = () => performance.now();
    const searchOpts = {
      difficulty: opts.difficulty,
      timeBudgetMs: opts.budget,
      now,
    };
    if (opts.maxDepth !== undefined) searchOpts.maxDepth = opts.maxDepth;
    if (opts.maxNodes !== undefined) searchOpts.maxNodes = opts.maxNodes;

    const session = createSearchSession(game, color, searchOpts);
    const start = performance.now();

    while (session.step(32)) {
      // 模拟 Worker/Node 运行环境
    }

    const elapsed = performance.now() - start;
    const stats = session.stats();
    const bestMove = session.result();
    const nps = stats.nodes > 0 && stats.elapsedMs > 0
      ? Math.round((stats.nodes / (stats.elapsedMs / 1000)))
      : 0;

    results.push({
      seed,
      stones: game.moves.length,
      bestMove,
      depth: stats.depth,
      nodes: stats.nodes,
      elapsedMs: Math.round(stats.elapsedMs),
      wallMs: Math.round(elapsed),
      budgetUtilization: +(stats.elapsedMs / opts.budget).toFixed(3),
      nps,
      cutoff: stats.cutoff,
      bestScore: stats.bestScore,
    });
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ options: opts, results }, null, 2) + '\n');
    return;
  }

  // 格式化表格输出
  console.log(`\n=== AI Benchmark (M6 P0-1) ===`);
  console.log(`预算: ${opts.budget}ms | 档位: ${opts.difficulty} | 局面数: ${opts.positions}\n`);
  console.log(
    `| Seed | 深度 | 节点数 | 耗时(ms) | 预算利用率 | 吞吐(nps) | 终止原因 | 选点 | 分数 |`,
  );
  console.log(
    `|---|---|---|---|---|---|---|---|---|`,
  );

  let totalNodes = 0;
  let totalElapsed = 0;
  let timeCutoffCount = 0;
  let depthCutoffCount = 0;

  for (const r of results) {
    totalNodes += r.nodes;
    totalElapsed += r.elapsedMs;
    if (r.cutoff === 'time') timeCutoffCount += 1;
    if (r.cutoff === 'depth') depthCutoffCount += 1;

    const moveStr = r.bestMove ? `[${r.bestMove[0]},${r.bestMove[1]}]` : 'null';
    const utilPct = `${(r.budgetUtilization * 100).toFixed(1)}%`;
    console.log(
      `| ${r.seed} | ${r.depth} | ${r.nodes.toLocaleString()} | ${r.elapsedMs} | ${utilPct} | ${r.nps.toLocaleString()} | ${r.cutoff} | ${moveStr} | ${r.bestScore} |`,
    );
  }

  const avgElapsed = Math.round(totalElapsed / results.length);
  const avgNodes = Math.round(totalNodes / results.length);
  const avgNps = Math.round(totalNodes / (totalElapsed / 1000));
  const avgUtil = ((totalElapsed / (results.length * opts.budget)) * 100).toFixed(1);

  console.log(`\n--- 汇总指标 (M1/M2 观测) ---`);
  console.log(`- 平均耗时: ${avgElapsed} ms`);
  console.log(`- 总体预算利用率: ${avgUtil}% (PRD M1 目标: ≥85%)`);
  console.log(`- 终止原因分布: time=${timeCutoffCount}/${results.length}, depth=${depthCutoffCount}/${results.length}`);
  console.log(`- 平均吞吐: ${avgNps.toLocaleString()} nps (常规目标: ≥60k, 威胁局面: ≥12k)\n`);
}

runBench().catch((err) => {
  console.error(err);
  process.exit(1);
});
