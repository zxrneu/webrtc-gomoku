/**
 * 局面评估测试：单调性 + 增量一致性。
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  COMBO_DOUBLE_THREE,
  PATTERN_SCORES,
  WHITE,
  createPositionState,
  evalFor,
  evaluateBoard,
  fromGameState,
  idxOf,
  placeStone,
  pointScore,
  removeStone,
  setCellAtIdx,
  type AiBoard,
  type PositionState,
} from '../../src/index';
import { buildAlternating } from './helpers';

/** 我方活四 vs 对方活三 */
function openFourVsOpenThree() {
  return buildAlternating(
    [
      [4, 7],
      [5, 7],
      [6, 7],
      [7, 7],
    ],
    [
      [4, 9],
      [5, 9],
      [6, 9],
    ],
  );
}

describe('evaluateBoard（局面分单调性）', () => {
  it('我方活四 > 对方活三：黑视角为正、白视角为负', () => {
    const g = openFourVsOpenThree();
    const black = evaluateBoard(g, BLACK);
    const white = evaluateBoard(g, WHITE);
    expect(black).toBeGreaterThan(0);
    expect(white).toBeLessThan(0);
    // 防守权重 1.1 使两侧不等值，但符号必须相反
    expect(Math.abs(black)).toBeGreaterThan(0);
  });

  it('同一局面双方视角符号相反（评估区分敌我）', () => {
    const g = buildAlternating(
      [
        [4, 7],
        [5, 7],
        [6, 7],
      ],
      [
        [0, 0],
        [0, 2],
        [14, 14],
      ],
    );
    expect(evaluateBoard(g, BLACK)).toBeGreaterThan(0);
    expect(evaluateBoard(g, WHITE)).toBeLessThan(0);
  });

  it('空盘双方均为 0', () => {
    const g = buildAlternating([], []);
    expect(evaluateBoard(g, BLACK)).toBe(0);
    expect(evaluateBoard(g, WHITE)).toBe(0);
  });

  it('对称局面下防守权重 1.1 使行棋方略偏保守（分数为轻微负值）', () => {
    const g = buildAlternating(
      [
        [4, 7],
        [5, 7],
        [6, 7],
      ],
      [
        [4, 9],
        [5, 9],
        [6, 9],
      ],
    );
    // 双方各一个活三：own - opp * 1.1 < 0，这是「略偏堵」的设计意图
    expect(evaluateBoard(g, BLACK)).toBeLessThan(0);
    expect(evaluateBoard(g, BLACK)).toBeGreaterThan(-PATTERN_SCORES.OPEN_THREE * 3);
  });

  it('子力越多分越高（单调递增）', () => {
    const one = buildAlternating([[7, 7]], [[0, 0]]);
    const two = buildAlternating(
      [
        [7, 7],
        [8, 8],
      ],
      [[0, 0]],
    );
    expect(evaluateBoard(two, BLACK)).toBeGreaterThan(evaluateBoard(one, BLACK));
  });
});

describe('组合威胁覆盖单点分值（架构 §1.2）', () => {
  it('双活三 > 单冲四', () => {
    // A：在 (7,7) 同时形成横/竖两个活三
    const a: AiBoard = new Int8Array(225);
    setCellAtIdx(a, idxOf(5, 7), BLACK);
    setCellAtIdx(a, idxOf(6, 7), BLACK);
    setCellAtIdx(a, idxOf(7, 5), BLACK);
    setCellAtIdx(a, idxOf(7, 6), BLACK);
    const doubleThree = pointScore(a, idxOf(7, 7), BLACK);

    // B：在 (7,7) 形成一个被挡住的冲四
    const b: AiBoard = new Int8Array(225);
    setCellAtIdx(b, idxOf(4, 7), BLACK);
    setCellAtIdx(b, idxOf(5, 7), BLACK);
    setCellAtIdx(b, idxOf(6, 7), BLACK);
    setCellAtIdx(b, idxOf(3, 7), WHITE);
    const singleFour = pointScore(b, idxOf(7, 7), BLACK);

    expect(doubleThree).toBe(COMBO_DOUBLE_THREE);
    expect(singleFour).toBe(PATTERN_SCORES.FOUR);
    expect(doubleThree).toBeGreaterThan(singleFour);
  });

  it('双四 > 活四 > 四三 > 双活三', () => {
    // 双四：横竖各三条
    const df: AiBoard = new Int8Array(225);
    for (const x of [4, 5, 6]) setCellAtIdx(df, idxOf(x, 7), BLACK);
    for (const y of [4, 5, 6]) setCellAtIdx(df, idxOf(7, y), BLACK);
    setCellAtIdx(df, idxOf(3, 7), WHITE);
    setCellAtIdx(df, idxOf(7, 3), WHITE);
    expect(pointScore(df, idxOf(7, 7), BLACK)).toBe(800_000);

    // 四三：一条冲四 + 一条活三
    const ft: AiBoard = new Int8Array(225);
    for (const x of [4, 5, 6]) setCellAtIdx(ft, idxOf(x, 7), BLACK);
    setCellAtIdx(ft, idxOf(3, 7), WHITE);
    for (const y of [8, 9]) setCellAtIdx(ft, idxOf(7, y), BLACK);
    expect(pointScore(ft, idxOf(7, 7), BLACK)).toBe(400_000);
  });

  it('成五优先于任何组合', () => {
    const b: AiBoard = new Int8Array(225);
    for (const x of [3, 4, 5, 6]) setCellAtIdx(b, idxOf(x, 7), BLACK);
    for (const y of [4, 5, 6]) setCellAtIdx(b, idxOf(7, y), BLACK);
    setCellAtIdx(b, idxOf(2, 7), WHITE);
    setCellAtIdx(b, idxOf(7, 3), WHITE);
    expect(pointScore(b, idxOf(7, 7), BLACK)).toBe(PATTERN_SCORES.FIVE);
  });
});

describe('增量评估与全量重建一致（架构 §1.3 / §9 R6）', () => {
  function boardWith(stones: readonly (readonly [number, number, 1 | 2])[]): AiBoard {
    const b: AiBoard = new Int8Array(225);
    for (const [x, y, c] of stones) setCellAtIdx(b, idxOf(x, y), c);
    return b;
  }

  function expectSameTotals(a: PositionState, b: PositionState): void {
    expect(a.totals[1]).toBeCloseTo(b.totals[1] ?? 0, 6);
    expect(a.totals[2]).toBeCloseTo(b.totals[2] ?? 0, 6);
    for (let i = 0; i < 225; i += 3) {
      expect(a.pointScore[i]).toBe(b.pointScore[i]);
    }
  }

  it('逐步落子后与重建状态完全一致', () => {
    const steps: readonly (readonly [number, number, 1 | 2])[] = [
      [7, 7, 1],
      [7, 8, 2],
      [8, 7, 1],
      [6, 7, 2],
      [6, 6, 1],
      [8, 8, 2],
      [5, 5, 1],
      [9, 9, 2],
      [5, 8, 1],
    ];
    const st = createPositionState(new Int8Array(225));
    const applied: (readonly [number, number, 1 | 2])[] = [];
    for (const s of steps) {
      applied.push(s);
      placeStone(st, idxOf(s[0], s[1]), s[2]);
      expectSameTotals(st, createPositionState(boardWith(applied)));
    }
    // 依次撤销，仍必须与全量重建一致
    const remaining = applied.slice();
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const last = remaining.pop();
      if (last === undefined) break;
      removeStone(st, idxOf(last[0], last[1]));
      expectSameTotals(st, createPositionState(boardWith(remaining)));
    }
    expect(st.stoneCount).toBe(0);
    expect(st.totals[1]).toBe(0);
    expect(st.totals[2]).toBe(0);
  });

  it('评估结果与 fromGameState 重建一致', () => {
    const g = openFourVsOpenThree();
    const st = createPositionState(fromGameState(g));
    expect(evalFor(st, BLACK)).toBe(evaluateBoard(g, BLACK));
    expect(evalFor(st, WHITE)).toBe(evaluateBoard(g, WHITE));
  });
});
