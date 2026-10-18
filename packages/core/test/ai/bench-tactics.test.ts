/**
 * PRD S1 战术基准集（20 题）。
 *
 * 题目全部用显式落子序列构造，断言的是「行为」而非某个内部走法：
 * - `win`    一步成五：AI 落子后立刻成五
 * - `block`  堵成五：AI 落子后对方不再有任何成五点
 * - `defend` 活三防守：AI 落子后对方无法在 5 个半回合内强制取胜
 * - `forced` 双三/双四/算杀：AI 落子后存在 5 个半回合内的强制取胜路线
 *
 * 「强制取胜」由 `helpers.ts` 里独立于引擎的判定器验证，因此断言的是棋力本身。
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  applyMove,
  findBestMove,
  otherColor,
  type AiOptions,
  type PlayerColor,
  type Point,
} from '../../src/index';
import { buildAlternating, cloneGame, fivePoints, opponentStillWins, winsAfterMove } from './helpers';

type Check = 'win' | 'block' | 'defend' | 'forced';

interface Problem {
  readonly name: string;
  readonly category: string;
  readonly black: readonly (readonly [number, number])[];
  readonly white: readonly (readonly [number, number])[];
  readonly ai: PlayerColor;
  readonly check: Check;
}

const PROBLEMS: readonly Problem[] = [
  // ---------- 一步成五 ×4 ----------
  {
    name: '横向四连补五',
    category: '一步成五',
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
    check: 'win',
  },
  {
    name: '纵向四连补五',
    category: '一步成五',
    black: [
      [7, 3],
      [7, 4],
      [7, 5],
      [7, 6],
    ],
    white: [
      [0, 0],
      [0, 2],
      [0, 4],
      [14, 14],
    ],
    ai: BLACK,
    check: 'win',
  },
  {
    name: '白方横向四连补五',
    category: '一步成五',
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
    check: 'win',
  },
  {
    name: '白方斜向四连补五',
    category: '一步成五',
    black: [
      [0, 0],
      [0, 2],
      [0, 4],
      [0, 6],
      [14, 14],
    ],
    white: [
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
    ],
    ai: WHITE,
    check: 'win',
  },

  // ---------- 堵成五 ×4 ----------
  {
    name: '堵黑方横向四连',
    category: '堵成五',
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
    check: 'block',
  },
  {
    name: '堵白方横向四连',
    category: '堵成五',
    black: [
      [2, 9],
      [0, 2],
      [0, 4],
      [14, 14],
    ],
    white: [
      [3, 9],
      [4, 9],
      [5, 9],
      [6, 9],
    ],
    ai: BLACK,
    check: 'block',
  },
  {
    name: '堵黑方纵向四连',
    category: '堵成五',
    black: [
      [7, 3],
      [7, 4],
      [7, 5],
      [7, 6],
      [0, 0],
    ],
    white: [
      [7, 2],
      [0, 2],
      [0, 4],
      [14, 14],
    ],
    ai: WHITE,
    check: 'block',
  },
  {
    name: '堵白方斜向四连',
    category: '堵成五',
    black: [
      [2, 2],
      [0, 2],
      [0, 4],
      [14, 14],
    ],
    white: [
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
    ],
    ai: BLACK,
    check: 'block',
  },

  // ---------- 活三防守 ×4 ----------
  {
    name: '防黑方横向活三',
    category: '活三防守',
    black: [
      [5, 5],
      [6, 5],
      [7, 5],
      [0, 0],
      [14, 14],
    ],
    white: [
      [0, 2],
      [0, 4],
      [0, 6],
      [14, 0],
    ],
    ai: WHITE,
    check: 'defend',
  },
  {
    name: '防白方横向活三',
    category: '活三防守',
    black: [
      [0, 0],
      [0, 2],
      [0, 4],
      [14, 14],
    ],
    white: [
      [5, 9],
      [6, 9],
      [7, 9],
      [14, 0],
    ],
    ai: BLACK,
    check: 'defend',
  },
  {
    name: '防黑方纵向活三',
    category: '活三防守',
    black: [
      [9, 5],
      [9, 6],
      [9, 7],
      [0, 0],
      [14, 14],
    ],
    white: [
      [0, 2],
      [0, 4],
      [0, 6],
      [14, 0],
    ],
    ai: WHITE,
    check: 'defend',
  },
  {
    name: '防白方斜向活三',
    category: '活三防守',
    black: [
      [0, 0],
      [0, 2],
      [0, 4],
      [14, 14],
    ],
    white: [
      [5, 5],
      [6, 6],
      [7, 7],
      [14, 0],
    ],
    ai: BLACK,
    check: 'defend',
  },

  // ---------- 双三 / 双四 ×4 ----------
  {
    name: '横竖双四必杀',
    category: '双三双四',
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
    check: 'forced',
  },
  {
    name: '四三复合威胁',
    category: '双三双四',
    black: [
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 7],
      [6, 8],
    ],
    white: [
      [2, 6],
      [0, 0],
      [0, 2],
      [14, 14],
      [14, 0],
    ],
    ai: BLACK,
    check: 'forced',
  },
  {
    name: '双斜向四连必杀',
    category: '双三双四',
    black: [
      [4, 4],
      [5, 5],
      [6, 6],
      [4, 10],
      [5, 9],
      [6, 8],
    ],
    white: [
      [3, 3],
      [3, 11],
      [0, 0],
      [0, 2],
      [14, 14],
      [14, 0],
    ],
    ai: BLACK,
    check: 'forced',
  },
  {
    name: '四三复合威胁（纵向活三）',
    category: '双三双四',
    black: [
      [4, 9],
      [5, 9],
      [6, 9],
      [7, 7],
      [7, 8],
    ],
    white: [
      [3, 9],
      [0, 0],
      [0, 2],
      [14, 14],
      [14, 0],
    ],
    ai: BLACK,
    check: 'forced',
  },

  // ---------- 三步算杀（VCF） ×4 ----------
  {
    name: '横向活三转活四',
    category: '三步 VCF',
    black: [
      [4, 7],
      [5, 7],
      [6, 7],
      [0, 0],
      [14, 14],
    ],
    white: [
      [0, 2],
      [0, 4],
      [0, 6],
      [14, 0],
      [14, 2],
    ],
    ai: BLACK,
    check: 'forced',
  },
  {
    name: '纵向活三转活四',
    category: '三步 VCF',
    black: [
      [9, 5],
      [9, 6],
      [9, 7],
      [0, 0],
      [14, 14],
    ],
    white: [
      [0, 2],
      [0, 4],
      [0, 6],
      [14, 0],
      [14, 2],
    ],
    ai: BLACK,
    check: 'forced',
  },
  {
    name: '斜向活三转活四',
    category: '三步 VCF',
    black: [
      [5, 5],
      [6, 6],
      [7, 7],
      [0, 0],
      [14, 14],
    ],
    white: [
      [0, 2],
      [0, 4],
      [0, 6],
      [14, 0],
      [14, 2],
    ],
    ai: BLACK,
    check: 'forced',
  },
  {
    name: '横竖双四必杀（第二组）',
    category: '三步 VCF',
    black: [
      [5, 8],
      [6, 8],
      [7, 8],
      [8, 5],
      [8, 6],
      [8, 7],
    ],
    white: [
      [4, 8],
      [8, 4],
      [0, 0],
      [0, 2],
      [14, 14],
      [14, 0],
    ],
    ai: BLACK,
    check: 'forced',
  },
];

/** bench 专用预算：节点上限压到 3000，使 20 题总耗时可控（深度上限仍是 hard 的 12） */
const BENCH_HARD: AiOptions = { difficulty: 'hard', maxNodes: 3000 };

/** 按题目断言类型校验 AI 的落点 */
function passes(problem: Problem, move: Point): boolean {
  const g = buildAlternating(problem.black, problem.white);
  if (problem.check === 'win') return winsAfterMove(g, move, problem.ai, 3);
  if (problem.check === 'block') {
    const work = cloneGame(g);
    const r = applyMove(work, move[0], move[1], problem.ai);
    if (!r.ok) return false;
    return fivePoints(work, otherColor(problem.ai)).length === 0;
  }
  if (problem.check === 'defend') return !opponentStillWins(g, move, problem.ai, 5);
  return winsAfterMove(g, move, problem.ai, 5);
}

describe('战术基准集 · hard 档（20/20）', () => {
  const failures: string[] = [];

  for (const p of PROBLEMS) {
    it(`[${p.category}] ${p.name}`, () => {
      const g = buildAlternating(p.black, p.white);
      const move = findBestMove(g, p.ai, BENCH_HARD);
      expect(move, 'AI 必须给出落点').not.toBeNull();
      if (move === null) {
        failures.push(p.name);
        return;
      }
      const ok = passes(p, move);
      if (!ok) failures.push(p.name);
      expect(ok, `AI 落点 (${move[0]},${move[1]}) 未达成本题目标`).toBe(true);
    });
  }

  it('汇总：hard 档 20/20 全数通过', () => {
    expect(PROBLEMS.length).toBe(20);
    expect(failures).toEqual([]);
  });
});

describe('战术基准集 · easy 档（≥10/20）', () => {
  it('简单档至少拿下 10 题', () => {
    let solved = 0;
    for (const p of PROBLEMS) {
      const g = buildAlternating(p.black, p.white);
      const move = findBestMove(g, p.ai, { difficulty: 'easy' });
      if (move !== null && passes(p, move)) solved += 1;
    }
    expect(solved).toBeGreaterThanOrEqual(10);
  });
});
