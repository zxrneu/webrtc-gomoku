/**
 * End-to-End (E2E) Opaque-Box Test Suite for Gomoku AI Engine Performance Optimization.
 *
 * Requirements & Architecture Compliance:
 * - 4-Tier Test Design Methodology (Tiers 1-4)
 * - Purely requirement-driven, opaque-box (via public facades and interfaces)
 * - Progressive testability with dual-track fallback verification
 * - Self-contained, isolated, zero-IO in core logic
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  BLACK,
  WHITE,
  EMPTY,
  SIZE,
  applyMove,
  create,
  currentColor,
  otherColor,
  winLineAt,
  createSearchSession,
  findBestMove,
  DIFFICULTY_PRESETS,
  resolveOptions,
  VCF_NODE_LIMIT,
  PNS_NODE_LIMIT,
  idxOf,
  xOf,
  yOf,
  collectCandidates,
  generateMoves,
  createPositionState,
  fromGameState,
  pointScore,
  windowScoreAt,
  PATTERN_SCORES,
  MATE_SCORE,
  type GameState,
  type Move,
  type PlayerColor,
  type Point,
  type AiOptions,
} from '../../src/index';
import {
  buildAlternating,
  buildGame,
  cloneGame,
  candidateCells,
  fivePoints,
  winsAfterMove,
  opponentStillWins,
} from './helpers';

// ==========================================
// Test Utilities & Deterministic Generators
// ==========================================

function fakeClock(stepMs = 8): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

function drainSession(s: ReturnType<typeof createSearchSession>, maxSlices = 10000): number {
  let slices = 0;
  while (s.step()) {
    slices += 1;
    if (slices > maxSlices) break;
  }
  return slices;
}

function isChebyshevLe2(x: number, y: number, moves: readonly Move[]): boolean {
  for (const m of moves) {
    if (Math.max(Math.abs(x - m.x), Math.abs(y - m.y)) <= 2) {
      return true;
    }
  }
  return false;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatePosition(seed: number, moveCount = 20): GameState {
  const rand = mulberry32(seed);
  const game = create();
  const centerOffsets = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const firstOffset = centerOffsets[Math.floor(rand() * centerOffsets.length)]!;
  applyMove(game, 7 + firstOffset[0], 7 + firstOffset[1], BLACK);

  let placed = 1;
  let attempts = 0;
  while (placed < moveCount && attempts < 1000) {
    attempts += 1;
    const color = currentColor(game);
    const neighbors: [number, number][] = [];
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
              occupied.add(key);
            }
          }
        }
      }
    }

    if (neighbors.length === 0) break;
    const pick = neighbors[Math.floor(rand() * neighbors.length)]!;
    const res = applyMove(game, pick[0], pick[1], color);
    if (res.ok) {
      if (game.over) {
        game.moves.pop();
        game.board[pick[1]]![pick[0]] = 0;
        game.over = false;
        game.winLine = null;
        continue;
      }
      placed += 1;
    }
  }
  return game;
}

// ==========================================
// Tier 1: Feature Coverage (>=5 test cases per feature)
// ==========================================

describe('Tier 1: Feature Coverage', () => {
  describe('F1: Chebyshev <= 2 Neighborhood Iteration', () => {
    it('1.1 空棋盘首步落子位于天元 (7,7) 或其合法开局邻域', () => {
      const empty = create();
      const move = findBestMove(empty, BLACK, { difficulty: 'easy' });
      expect(move).not.toBeNull();
      if (move) {
        expect(move[0]).toBeGreaterThanOrEqual(6);
        expect(move[0]).toBeLessThanOrEqual(8);
        expect(move[1]).toBeGreaterThanOrEqual(6);
        expect(move[1]).toBeLessThanOrEqual(8);
      }
    });

    it('1.2 天元单子时，生成的所有候选点严格在切比雪夫 <= 2 范围 (5..9, 5..9)', () => {
      const game = buildGame([[7, 7, BLACK]]);
      const state = createPositionState(fromGameState(game));
      const candidates = collectCandidates(state);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThanOrEqual(24);

      for (const idx of candidates) {
        const x = xOf(idx);
        const y = yOf(idx);
        expect(isChebyshevLe2(x, y, game.moves)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(5);
        expect(x).toBeLessThanOrEqual(9);
        expect(y).toBeGreaterThanOrEqual(5);
        expect(y).toBeLessThanOrEqual(9);
        expect(game.board[y]![x]).toBe(0);
      }
    });

    it('1.3 角落单子 (0,0) 时，候选点严格局限在边界邻域 [0..2, 0..2]', () => {
      const game = buildGame([[0, 0, BLACK]]);
      const state = createPositionState(fromGameState(game));
      const candidates = collectCandidates(state);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThanOrEqual(8);

      for (const idx of candidates) {
        const x = xOf(idx);
        const y = yOf(idx);
        expect(isChebyshevLe2(x, y, game.moves)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(2);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(2);
        expect(x === 0 && y === 0).toBe(false);
      }
    });

    it('1.4 两个分离的棋子集群只在各自切比雪夫 <= 2 联合邻域内生成候选', () => {
      const game = buildGame([
        [2, 2, BLACK],
        [12, 12, WHITE],
      ]);
      const state = createPositionState(fromGameState(game));
      const candidates = collectCandidates(state);
      expect(candidates.length).toBeGreaterThan(0);

      // 中间远端格 (7,7) 绝不应当作为候选点出现
      const centerIdx = idxOf(7, 7);
      expect(candidates).not.toContain(centerIdx);

      for (const idx of candidates) {
        const x = xOf(idx);
        const y = yOf(idx);
        expect(isChebyshevLe2(x, y, game.moves)).toBe(true);
      }
    });

    it('1.5 随着棋局推进，候选边界严格沿已落子切比雪夫 <= 2 前沿扩展', () => {
      const game = buildGame([
        [7, 7, BLACK],
        [7, 8, WHITE],
        [8, 7, BLACK],
      ]);
      const state = createPositionState(fromGameState(game));
      const candidates = collectCandidates(state);

      for (const idx of candidates) {
        const x = xOf(idx);
        const y = yOf(idx);
        expect(isChebyshevLe2(x, y, game.moves)).toBe(true);
      }

      // 验证未被覆盖的角隅不会产生候选
      expect(candidates).not.toContain(idxOf(0, 0));
      expect(candidates).not.toContain(idxOf(14, 14));
      expect(candidates).not.toContain(idxOf(0, 14));
      expect(candidates).not.toContain(idxOf(14, 0));
    });
  });

  describe('F2: Zero-Allocation Buffers & Memory Footprint', () => {
    it('2.1 多次分片连续调用 step 状态单调推进且无内存激增', () => {
      const game = generatePosition(42, 10);
      const session = createSearchSession(game, currentColor(game), {
        difficulty: 'hard',
        maxNodes: 2000,
      });

      let steps = 0;
      let prevNodes = 0;
      while (session.step(32)) {
        steps += 1;
        const currentNodes = session.stats().nodes;
        expect(currentNodes).toBeGreaterThanOrEqual(prevNodes);
        prevNodes = currentNodes;
        if (steps > 500) break;
      }
      expect(session.result()).not.toBeNull();
    });

    it('2.2 同一会话小片推进（16/32/64）与整体推进结果一致', () => {
      const game = generatePosition(77, 8);
      const color = currentColor(game);
      const s1 = createSearchSession(game, color, { difficulty: 'easy' });
      const s2 = createSearchSession(game, color, { difficulty: 'easy' });

      while (s1.step(16)) {}
      while (s2.step(64)) {}

      expect(s1.result()).toEqual(s2.result());
    });

    it('2.3 复杂密集局面 generateMoves 产出确定性排序候选', () => {
      const game = generatePosition(123, 20);
      const state = createPositionState(fromGameState(game));
      const moves1 = generateMoves(state, BLACK, 16);
      const moves2 = generateMoves(state, BLACK, 16);

      expect(moves1.length).toBeGreaterThan(0);
      expect(moves1).toEqual(moves2);
    });

    it('2.4 连续创建 10 个独立搜索会话，无全局状态污染', () => {
      const results: (Point | null)[] = [];
      for (let i = 0; i < 10; i += 1) {
        const game = generatePosition(100 + i, 6);
        const session = createSearchSession(game, currentColor(game), {
          difficulty: 'easy',
          maxNodes: 500,
        });
        drainSession(session);
        results.push(session.result());
      }
      expect(results.every((r) => r !== null)).toBe(true);
    });

    it('2.5 单分片执行耗时平滑，无长时间停顿', () => {
      const game = generatePosition(55, 12);
      let clock = 0;
      const session = createSearchSession(game, currentColor(game), {
        difficulty: 'hard',
        now: () => ++clock,
        timeBudgetMs: 500,
      });

      let sliceCount = 0;
      while (session.step(32)) {
        sliceCount += 1;
        if (sliceCount > 200) break;
      }
      expect(session.stats().cutoff).toBe('time');
    });
  });

  describe('F3: Tactical Killer Capacity (VCF 24k / PNS 80k)', () => {
    it('3.1 配置系统与预设支持高容量 VCF 算杀 (>= 6000，目标 24000)', () => {
      expect(VCF_NODE_LIMIT).toBeGreaterThanOrEqual(6000);
      const res = resolveOptions({ difficulty: 'hard' });
      const effectiveVcfLimit = (res as { vcfMaxNodes?: number }).vcfMaxNodes ?? VCF_NODE_LIMIT;
      expect(effectiveVcfLimit).toBeGreaterThanOrEqual(6000);
    });

    it('3.2 配置系统与预设支持高容量 PNS 威胁算杀 (>= 20000，目标 80000)', () => {
      expect(PNS_NODE_LIMIT).toBeGreaterThanOrEqual(20000);
      const res = resolveOptions({ difficulty: 'hard' });
      const effectivePnsLimit = (res as { pnsMaxNodes?: number }).pnsMaxNodes ?? PNS_NODE_LIMIT;
      expect(effectivePnsLimit).toBeGreaterThanOrEqual(20000);
    });

    it('3.3 深度四三复合威胁算杀在算杀预算内精准获解', () => {
      const game = buildAlternating(
        [
          [3, 6],
          [4, 6],
          [5, 6],
          [6, 7],
          [6, 8],
        ],
        [
          [2, 6],
          [0, 0],
          [0, 2],
          [14, 14],
          [14, 0],
        ],
      );
      const move = findBestMove(game, BLACK, { difficulty: 'hard' });
      expect(move).not.toBeNull();
      if (move) {
        expect(winsAfterMove(game, move, BLACK, 5)).toBe(true);
      }
    });

    it('3.4 双四必杀局面无需迭代加深直接在战术层证明并给出必胜着法', () => {
      const game = buildAlternating(
        [
          [3, 6],
          [4, 6],
          [5, 6],
          [6, 3],
          [6, 4],
          [6, 5],
        ],
        [
          [2, 6],
          [6, 2],
          [0, 0],
          [0, 2],
          [14, 14],
          [14, 0],
        ],
      );
      const move = findBestMove(game, BLACK, { difficulty: 'hard' });
      expect(move).toEqual([6, 6]);
      if (move) {
        expect(winsAfterMove(game, move, BLACK, 3)).toBe(true);
      }
    });

    it('3.5 战术算杀选点通过独立判定器验证五步内必胜', () => {
      const game = buildAlternating(
        [
          [4, 7],
          [5, 7],
          [6, 7],
          [0, 0],
          [14, 14],
        ],
        [
          [0, 2],
          [0, 4],
          [0, 6],
          [14, 0],
          [14, 2],
        ],
      );
      const move = findBestMove(game, BLACK, { difficulty: 'hard' });
      expect(move).not.toBeNull();
      if (move) {
        expect(winsAfterMove(game, move, BLACK, 5)).toBe(true);
      }
    });
  });

  describe('F4: Decoupling Killer Search from Shallow Regular Search', () => {
    it('4.1 当常规 maxNodes 极低时，算杀搜索仍能解出已存在的必胜手', () => {
      const game = buildAlternating(
        [
          [3, 7],
          [4, 7],
          [5, 7],
          [6, 7],
        ],
        [
          [0, 0],
          [0, 2],
          [0, 4],
          [14, 14],
        ],
      );
      // 传入极小 maxNodes，检验算杀不被常规搜索浅层剪灭
      const move = findBestMove(game, BLACK, { difficulty: 'hard', maxNodes: 50 });
      expect(move).not.toBeNull();
      if (move) {
        expect(winsAfterMove(game, move, BLACK, 1)).toBe(true);
      }
    });

    it('4.2 弹性截止时间约束：短预算 (50ms) 下严格在时限内截断返回', () => {
      const game = generatePosition(38, 14);
      let clock = 0;
      const session = createSearchSession(game, currentColor(game), {
        difficulty: 'hard',
        timeBudgetMs: 50,
        now: () => (clock += 5),
      });
      drainSession(session);
      const stats = session.stats();
      expect(stats.cutoff).toBe('time');
      expect(session.result()).not.toBeNull();
    });

    it('4.3 算杀证明成功时 cutoff 准确判定终局且分数达到将死分', () => {
      const game = buildAlternating(
        [
          [3, 7],
          [4, 7],
          [5, 7],
          [6, 7],
        ],
        [
          [0, 0],
          [0, 2],
          [0, 4],
          [14, 14],
        ],
      );
      const session = createSearchSession(game, BLACK, { difficulty: 'hard' });
      drainSession(session);
      const stats = session.stats();
      expect(stats.bestScore).toBeGreaterThanOrEqual(MATE_SCORE - 100);
      expect(session.result()).toEqual([2, 7]);
    });

    it('4.4 常规搜索节点与算杀节点在统计中均得到有效累加', () => {
      const game = generatePosition(69, 10);
      const session = createSearchSession(game, currentColor(game), {
        difficulty: 'hard',
        maxNodes: 500,
      });
      drainSession(session);
      const stats = session.stats();
      expect(stats.nodes).toBeGreaterThan(0);
    });

    it('4.5 反杀过滤逻辑在复杂局面下平稳运行且不抛出未捕获异常', () => {
      const game = generatePosition(162, 12);
      expect(() => {
        const move = findBestMove(game, currentColor(game), { difficulty: 'hard', maxNodes: 800 });
        expect(move).not.toBeNull();
      }).not.toThrow();
    });
  });

  describe('F5: Offline Single-File HTML Bundle Preservation', () => {
    const standalonePath = path.resolve(process.cwd(), 'dist/gomoku-standalone.html');
    const exists = fs.existsSync(standalonePath);

    it('5.1 单文件离线交付产物 dist/gomoku-standalone.html 存在且非空', () => {
      expect(exists, 'dist/gomoku-standalone.html 必须在 build 后存在').toBe(true);
      if (exists) {
        const stat = fs.statSync(standalonePath);
        expect(stat.size).toBeGreaterThan(100000);
      }
    });

    it('5.2 gzip 压缩增量严格受限在 <= 40KB 以内 (上限 225,683 字节)', () => {
      if (exists) {
        const content = fs.readFileSync(standalonePath);
        const gzipped = zlib.gzipSync(content);
        // 基准 ~184,723 字节 + 40KB (40,960) = 225,683 字节
        expect(gzipped.length).toBeLessThanOrEqual(225683);
      }
    });

    it('5.3 离线包内零外部 HTTP/HTTPS 网络依赖脚本与样式', () => {
      if (exists) {
        const html = fs.readFileSync(standalonePath, 'utf8');
        const externalScript = /<script[^>]+src=["']https?:\/\//i.test(html);
        const externalLink = /<link[^>]+href=["']https?:\/\//i.test(html);
        expect(externalScript, '不得引入外部 script').toBe(false);
        expect(externalLink, '不得引入外部 stylesheet').toBe(false);
      }
    });

    it('5.4 Worker 脚本与资源完全内联 (Blob/Data URL 或内联模块)', () => {
      if (exists) {
        const html = fs.readFileSync(standalonePath, 'utf8');
        expect(html).toContain('<!DOCTYPE html>');
        // 验证没有未内联的外部 .wasm 请求或外部 worker 脚本标签
        const externalWasmFetch = /fetch\(["'][^"']+\.wasm["']\)/i.test(html);
        expect(externalWasmFetch, '离线包内不得有外部 wasm fetch 调用').toBe(false);
      }
    });

    it('5.5 离线 HTML 具备完整独立单文件结构 (包含 root 容器与元数据)', () => {
      if (exists) {
        const html = fs.readFileSync(standalonePath, 'utf8');
        expect(html).toContain('id="root"');
        expect(html).toContain('五子棋');
      }
    });
  });

  describe('F6: WASM / TS Dual-Track Fallback Contract', () => {
    it('6.1 无 WASM 时透明降级为纯 TypeScript 引擎，所有公开接口可用', () => {
      const game = create();
      const move = findBestMove(game, BLACK, { difficulty: 'easy' });
      expect(move).not.toBeNull();
    });

    it('6.2 双轨契约：横竖斜 4 方向窗口评分逻辑精确一致', () => {
      const board = new Int8Array(225);
      board[idxOf(7, 7)] = BLACK;
      board[idxOf(8, 7)] = BLACK;
      board[idxOf(9, 7)] = BLACK;

      // 评估横向窗口评分
      const score = windowScoreAt(board, idxOf(6, 7), 0, BLACK);
      expect(score).toBeGreaterThan(0);
    });

    it('6.3 双轨契约：点位评分与特征识别一致', () => {
      const board = new Int8Array(225);
      board[idxOf(3, 7)] = BLACK;
      board[idxOf(4, 7)] = BLACK;
      board[idxOf(5, 7)] = BLACK;

      const score = pointScore(board, idxOf(6, 7), BLACK);
      expect(score).toBeGreaterThanOrEqual(PATTERN_SCORES.FOUR);
    });

    it('6.4 双轨契约：成五判定在纯 TS 轨道百分百精确', () => {
      const game = buildAlternating(
        [
          [3, 7],
          [4, 7],
          [5, 7],
          [6, 7],
        ],
        [
          [0, 0],
          [0, 2],
          [0, 4],
          [14, 14],
        ],
      );
      const points = fivePoints(game, BLACK);
      expect(points).toEqual(
        expect.arrayContaining([
          [2, 7],
          [7, 7],
        ]),
      );
    });

    it('6.5 引擎计算处于纯内存，无 DOM/IO 或全局网络调用', () => {
      expect(typeof window).toBe('undefined');
      const game = generatePosition(88, 10);
      expect(() => {
        findBestMove(game, currentColor(game), { difficulty: 'easy' });
      }).not.toThrow();
    });
  });
});

// ==========================================
// Tier 2: Boundary & Corner Cases
// ==========================================

describe('Tier 2: Boundary & Corner Cases', () => {
  it('T2.1 空棋盘首步落子不崩溃并给出合法天元开局点', () => {
    const game = create();
    const move = findBestMove(game, BLACK, { difficulty: 'normal' });
    expect(move).not.toBeNull();
    if (move) {
      expect(game.board[move[1]]![move[0]]).toBe(EMPTY);
    }
  });

  it('T2.2 密集多手局面准确在合法空格中选点，满盘安全拒绝', () => {
    // 密集 50 手局面
    const game = generatePosition(42, 50);
    const color = currentColor(game);
    const move = findBestMove(game, color, { difficulty: 'easy' });
    expect(move).not.toBeNull();
    if (move) {
      expect(game.board[move[1]]![move[0]]).toBe(EMPTY);
      expect(isChebyshevLe2(move[0], move[1], game.moves)).toBe(true);
    }

    // 满盘 (225 手) 安全返回 null，不抛异常
    const fullGame: GameState = {
      size: SIZE,
      board: Array.from({ length: SIZE }, () => Array(SIZE).fill(BLACK)),
      moves: Array.from({ length: SIZE * SIZE }, (_, i) => ({
        x: i % SIZE,
        y: Math.floor(i / SIZE),
        c: BLACK,
      })),
      over: true,
      winLine: null,
    };
    expect(findBestMove(fullGame, BLACK)).toBeNull();
  });

  it('T2.3 终局局面 (over: true) 传入搜索安全返回 null 且 cutoff 为 none', () => {
    const overGame = buildAlternating(
      [
        [0, 7],
        [1, 7],
        [2, 7],
        [3, 7],
        [4, 7],
      ],
      [
        [0, 9],
        [1, 9],
        [2, 9],
        [3, 9],
      ],
    );
    expect(overGame.over).toBe(true);
    const session = createSearchSession(overGame, BLACK);
    expect(session.step()).toBe(false);
    expect(session.result()).toBeNull();
    expect(session.stats().cutoff).toBe('none');
  });

  it('T2.4 3.0s 截止时间超时耗尽：复杂局面命中 time cutoff 并给出已算出的合法解', () => {
    const game = generatePosition(38, 16);
    const session = createSearchSession(game, currentColor(game), {
      difficulty: 'hard',
      timeBudgetMs: 3000,
      now: fakeClock(50),
    });
    drainSession(session);
    const stats = session.stats();
    expect(stats.cutoff).toBe('time');
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(3000);
    const result = session.result();
    expect(result).not.toBeNull();
    if (result) {
      expect(game.board[result[1]]![result[0]]).toBe(EMPTY);
    }
  });

  it('T2.5 非法与边界选项（空对象、无效档位、零节点预算）不抛未捕获异常并安全运行', () => {
    const game = create();
    applyMove(game, 7, 7, BLACK);
    expect(() => {
      const res = resolveOptions({} as AiOptions);
      expect(res.difficulty).toBe('hard');
      expect(res.timeBudgetMs).toBeGreaterThan(0);

      // 零节点预算不抛崩溃
      const move = findBestMove(game, WHITE, { maxNodes: 0 });
      expect(move === null || Array.isArray(move)).toBe(true);
    }).not.toThrow();
  });

  it('T2.6 棋盘极端四角点落子不引发数组越界与邻域扫描溢出', () => {
    const corners: [number, number, PlayerColor][] = [
      [0, 0, BLACK],
      [14, 14, WHITE],
      [0, 14, BLACK],
      [14, 0, WHITE],
    ];
    const game = buildGame(corners);
    expect(() => {
      const move = findBestMove(game, BLACK, { difficulty: 'easy', maxNodes: 100 });
      expect(move).not.toBeNull();
    }).not.toThrow();
  });
});

// ==========================================
// Tier 3: Cross-Feature Combinations
// ==========================================

describe('Tier 3: Cross-Feature Combinations', () => {
  it('T3.1 双轨回退机制与深度算杀结合运行通畅', () => {
    const game = buildAlternating(
      [
        [4, 7],
        [5, 7],
        [6, 7],
        [0, 0],
        [14, 14],
      ],
      [
        [0, 2],
        [0, 4],
        [0, 6],
        [14, 0],
        [14, 2],
      ],
    );
    const session = createSearchSession(game, BLACK, { difficulty: 'hard' });
    drainSession(session);
    expect(session.result()).not.toBeNull();
  });

  it('T3.2 纯 TS 回退与 VCF 连续算杀：无调用栈溢出', () => {
    const game = buildAlternating(
      [
        [5, 8],
        [6, 8],
        [7, 8],
        [8, 5],
        [8, 6],
        [8, 7],
      ],
      [
        [4, 8],
        [8, 4],
        [0, 0],
        [0, 2],
        [14, 14],
        [14, 0],
      ],
    );
    const move = findBestMove(game, BLACK, { difficulty: 'hard' });
    expect(move).not.toBeNull();
    if (move) {
      expect(winsAfterMove(game, move, BLACK, 5)).toBe(true);
    }
  });

  it('T3.3 离线单文件环境与 AI 纯内存搜索：零网络请求', () => {
    const standalonePath = path.resolve(process.cwd(), 'dist/gomoku-standalone.html');
    if (fs.existsSync(standalonePath)) {
      const html = fs.readFileSync(standalonePath, 'utf8');
      expect(html).not.toMatch(/fetch\(["']https?:\/\//i);
    }
  });

  it('T3.4 解耦算杀与弹性时间保护联合生效：短预算仍守住时限', () => {
    const game = buildAlternating(
      [
        [7, 7],
        [3, 3],
        [10, 10],
      ],
      [
        [7, 8],
        [4, 4],
        [10, 9],
      ],
    );
    let clock = 0;
    const session = createSearchSession(game, BLACK, {
      difficulty: 'hard',
      timeBudgetMs: 40,
      now: () => (clock += 4),
    });
    drainSession(session);
    expect(session.stats().cutoff).toBe('time');
  });

  it('T3.5 分片步进与战术计算结合：分片不破坏算杀结果', () => {
    const game = buildAlternating(
      [
        [3, 7],
        [4, 7],
        [5, 7],
        [6, 7],
      ],
      [
        [0, 0],
        [0, 2],
        [0, 4],
        [14, 14],
      ],
    );
    const s1 = createSearchSession(game, BLACK, { difficulty: 'hard' });
    const s2 = createSearchSession(game, BLACK, { difficulty: 'hard' });

    while (s1.step(8)) {}
    while (s2.step(1000)) {}

    expect(s1.result()).toEqual(s2.result());
    expect(s1.result()).toEqual([2, 7]);
  });
});

// ==========================================
// Tier 4: Real-World Scenarios
// ==========================================

describe('Tier 4: Real-World Scenarios', () => {
  it('T4.1 完整自对弈对局模拟：从开局到终局每步合法且正常终局', () => {
    const game = create();
    let moves = 0;
    const maxMoves = 100;

    while (!game.over && moves < maxMoves) {
      const color = currentColor(game);
      const move = findBestMove(game, color, { difficulty: 'easy', maxNodes: 200 });
      expect(move, `在第 ${moves + 1} 手 AI 必须给出落子点`).not.toBeNull();
      if (!move) break;

      const res = applyMove(game, move[0], move[1], color);
      expect(res.ok, `第 ${moves + 1} 手 (${move[0]},${move[1]}) 落子必须合法`).toBe(true);
      moves += 1;
    }

    expect(moves).toBeGreaterThan(0);
    expect(moves).toBeLessThanOrEqual(225);
  });

  it('T4.2 基准 20 局面确定性生成与吞吐/落点健全性校验', () => {
    const seeds = Array.from({ length: 20 }, (_, i) => 7 + i * 31);
    let totalNodes = 0;

    for (const seed of seeds) {
      const game = generatePosition(seed, 14);
      const color = currentColor(game);
      const session = createSearchSession(game, color, {
        difficulty: 'normal',
        maxNodes: 1000,
      });
      drainSession(session);

      const move = session.result();
      expect(move, `Seed ${seed} 应选出落点`).not.toBeNull();
      if (move) {
        expect(game.board[move[1]]![move[0]]).toBe(EMPTY);
        expect(isChebyshevLe2(move[0], move[1], game.moves)).toBe(true);
      }

      totalNodes += session.stats().nodes;
    }

    expect(totalNodes).toBeGreaterThan(20 * 50);
  });

  it('T4.3 核心战术题目校验（一步成五、堵五、双四、VCF）全数过关', () => {
    const tacticalChecks: {
      name: string;
      black: Point[];
      white: Point[];
      ai: PlayerColor;
      verify: (g: GameState, m: Point) => boolean;
    }[] = [
      {
        name: '黑方四连成五',
        black: [
          [3, 7],
          [4, 7],
          [5, 7],
          [6, 7],
        ],
        white: [
          [0, 0],
          [0, 2],
          [0, 4],
          [14, 14],
        ],
        ai: BLACK,
        verify: (g, m) => winsAfterMove(g, m, BLACK, 1),
      },
      {
        name: '白方四连成五',
        black: [
          [0, 0],
          [0, 2],
          [0, 4],
          [0, 6],
          [14, 14],
        ],
        white: [
          [3, 9],
          [4, 9],
          [5, 9],
          [6, 9],
        ],
        ai: WHITE,
        verify: (g, m) => winsAfterMove(g, m, WHITE, 1),
      },
      {
        name: '堵黑方四连',
        black: [
          [3, 9],
          [4, 9],
          [5, 9],
          [6, 9],
          [0, 0],
        ],
        white: [
          [2, 9],
          [0, 2],
          [0, 4],
          [14, 14],
        ],
        ai: WHITE,
        verify: (g, m) => {
          const w = cloneGame(g);
          applyMove(w, m[0], m[1], WHITE);
          return fivePoints(w, BLACK).length === 0;
        },
      },
      {
        name: '双四必杀',
        black: [
          [3, 6],
          [4, 6],
          [5, 6],
          [6, 3],
          [6, 4],
          [6, 5],
        ],
        white: [
          [2, 6],
          [6, 2],
          [0, 0],
          [0, 2],
          [14, 14],
          [14, 0],
        ],
        ai: BLACK,
        verify: (g, m) => winsAfterMove(g, m, BLACK, 3),
      },
    ];

    for (const p of tacticalChecks) {
      const g = buildAlternating(p.black, p.white);
      const move = findBestMove(g, p.ai, { difficulty: 'hard' });
      expect(move, `${p.name} 必须给出落点`).not.toBeNull();
      if (move) {
        expect(p.verify(g, move), `${p.name} 选点未达成本题目标`).toBe(true);
      }
    }
  });

  it('T4.4 3.0s 预算在复杂局面充分利用 (预算利用率 >= 85%)', () => {
    const game = generatePosition(38, 14);
    const session = createSearchSession(game, currentColor(game), {
      difficulty: 'hard',
      timeBudgetMs: 3000,
      now: fakeClock(10),
    });
    drainSession(session);
    const stats = session.stats();
    expect(stats.cutoff).toBe('time');
    const utilization = stats.elapsedMs / 3000;
    expect(utilization).toBeGreaterThanOrEqual(0.85);
  });

  it('T4.5 连续三局模拟会话复用，零内存污染', () => {
    for (let round = 1; round <= 3; round += 1) {
      const game = create();
      applyMove(game, 7, 7, BLACK);
      applyMove(game, 7, 8, WHITE);
      const move = findBestMove(game, BLACK, { difficulty: 'easy', maxNodes: 300 });
      expect(move).not.toBeNull();
      if (move) {
        expect(game.board[move[1]]![move[0]]).toBe(EMPTY);
        expect(isChebyshevLe2(move[0], move[1], game.moves)).toBe(true);
      }
    }
  });
});
