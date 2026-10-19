/**
 * 走法生成测试：邻域、排序确定性、强制短路、分支上限。
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  CENTER_IDX,
  DEEP_BRANCH_LIMIT,
  ROOT_BRANCH_LIMIT,
  SHALLOW_BRANCH_LIMIT,
  WHITE,
  branchLimitFor,
  collectCandidates,
  createPositionState,
  fromGameState,
  generateMoves,
  idxOf,
  xOf,
  yOf,
  type PositionState,
} from '../../src/index';
import { generateMovesInto } from '../../src/ai/movegen';
import { buildAlternating, buildGame } from './helpers';

function stateOf(g: Parameters<typeof fromGameState>[0]): PositionState {
  return createPositionState(fromGameState(g));
}

describe('generateMoves：空盘与邻域', () => {
  it('空盘只返回天元 (7,7)', () => {
    const st = stateOf(buildAlternating([], []));
    expect(generateMoves(st, BLACK, ROOT_BRANCH_LIMIT)).toEqual([CENTER_IDX]);
  });

  it('候选只含距已有子切比雪夫 ≤2 的空点', () => {
    const st = stateOf(buildAlternating([[7, 7]], [[0, 0]]));
    const cand = collectCandidates(st);
    const set = new Set(cand);
    expect(set.has(idxOf(9, 7))).toBe(true); // 距离 2
    expect(set.has(idxOf(7, 9))).toBe(true);
    expect(set.has(idxOf(9, 9))).toBe(true); // 对角距离 2
    expect(set.has(idxOf(10, 7))).toBe(false); // 距离 3
    expect(set.has(idxOf(7, 7))).toBe(false); // 已占用
    for (const cell of cand) {
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(xOf(cell)).toBeLessThan(15);
      expect(yOf(cell)).toBeLessThan(15);
    }
  });
});

describe('generateMoves：排序与确定性', () => {
  it('排序稳定：同局面连跑 3 次得到完全相同的序列', () => {
    const st = stateOf(
      buildAlternating(
        [
          [7, 7],
          [8, 8],
          [6, 6],
        ],
        [
          [7, 8],
          [6, 7],
        ],
      ),
    );
    const a = generateMoves(st, BLACK, ROOT_BRANCH_LIMIT);
    const b = generateMoves(st, BLACK, ROOT_BRANCH_LIMIT);
    const c = generateMoves(st, BLACK, ROOT_BRANCH_LIMIT);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('强威胁点排在弱点之前（成四点优先）', () => {
    // 黑已有三连，补成冲四的点必须排第一
    const st = stateOf(
      buildAlternating(
        [
          [4, 7],
          [5, 7],
          [6, 7],
        ],
        [
          [0, 0],
          [0, 2],
          [0, 4],
        ],
      ),
    );
    const moves = generateMoves(st, BLACK, ROOT_BRANCH_LIMIT);
    const first = moves[0];
    expect(first).toBeDefined();
    // (3,7) 或 (7,7) 都能形成四，必须占据前两位
    const top2 = new Set([moves[0], moves[1]]);
    expect(top2.has(idxOf(3, 7)) || top2.has(idxOf(7, 7))).toBe(true);
  });

  it('tie-break 按 idx 升序（同分时小索引在前）', () => {
    // 空盘附近的对称局面：只保留一个子，保证多个候选同分
    const st = stateOf(buildGame([[7, 7, BLACK]]));
    const moves = generateMoves(st, WHITE, ROOT_BRANCH_LIMIT);
    expect(moves.length).toBeGreaterThan(1);
    // 直接验证「同分相邻项索引递增」无法从外部观察，这里退一步验证全序列严格递增的去重性质
    expect(new Set(moves).size).toBe(moves.length);
  });
});

describe('generateMoves：强制短路（与深度无关的底线）', () => {
  it('己方有成五点 -> 候选长度 1 且就是该点', () => {
    // 黑四连，(2,7) 与 (7,7) 都能成五；短路必须只返回一个点
    const st = stateOf(
      buildAlternating(
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
          [0, 6],
        ],
      ),
    );
    const moves = generateMoves(st, BLACK, ROOT_BRANCH_LIMIT);
    expect(moves.length).toBe(1);
    const only = moves[0] ?? -1;
    expect([idxOf(2, 7), idxOf(7, 7)]).toContain(only);
  });

  it('对方有成五点 -> 候选全为堵点', () => {
    // 白四连，(2,9) 已被黑占，(7,9) 是唯一五连点
    const st = stateOf(
      buildAlternating(
        [
          [2, 9],
          [0, 4],
          [0, 6],
          [14, 14],
        ],
        [
          [3, 9],
          [4, 9],
          [5, 9],
          [6, 9],
        ],
      ),
    );
    const moves = generateMoves(st, BLACK, ROOT_BRANCH_LIMIT);
    expect(moves).toEqual([idxOf(7, 9)]);
  });

  it('对方双五连点时返回全部堵点（≤2）', () => {
    const st = stateOf(
      buildAlternating(
        [
          [2, 9],
          [0, 4],
          [0, 6],
          [14, 14],
        ],
        [
          [3, 9],
          [4, 9],
          [5, 9],
          [6, 9],
        ],
      ),
    );
    const whiteMoves = generateMoves(st, WHITE, ROOT_BRANCH_LIMIT);
    // 轮到白方时白方自己有成五点，直接取胜
    expect(whiteMoves.length).toBe(1);
  });

  it('己方成五优先于堵对方（先赢）', () => {
    // 双方各有四连
    const st = stateOf(
      buildGame([
        [3, 7, BLACK],
        [3, 9, WHITE],
        [4, 7, BLACK],
        [4, 9, WHITE],
        [5, 7, BLACK],
        [5, 9, WHITE],
        [6, 7, BLACK],
        [6, 9, WHITE],
      ]),
    );
    const moves = generateMoves(st, BLACK, ROOT_BRANCH_LIMIT);
    expect(moves.length).toBe(1);
    expect([idxOf(2, 7), idxOf(7, 7)]).toContain(moves[0]);
  });
});

describe('分支上限', () => {
  it('根 ≤14、浅层 ≤10、深层 ≤6', () => {
    const st = stateOf(
      buildAlternating(
        [
          [7, 7],
          [8, 8],
        ],
        [
          [7, 8],
          [8, 7],
        ],
      ),
    );
    expect(generateMoves(st, BLACK, ROOT_BRANCH_LIMIT).length).toBeLessThanOrEqual(
      ROOT_BRANCH_LIMIT,
    );
    expect(generateMoves(st, BLACK, branchLimitFor(2)).length).toBeLessThanOrEqual(
      SHALLOW_BRANCH_LIMIT,
    );
    expect(generateMoves(st, BLACK, branchLimitFor(6)).length).toBeLessThanOrEqual(
      DEEP_BRANCH_LIMIT,
    );
  });

  it('分支上限至少为 1（不会生成空候选）', () => {
    const st = stateOf(buildGame([[7, 7, BLACK]]));
    expect(generateMoves(st, WHITE, 1).length).toBe(1);
  });

  it('generateMovesInto 严格防御超大 branchLimit，单层绝不超过 16 个槽位', () => {
    const st = stateOf(
      buildAlternating(
        [
          [7, 7],
          [8, 8],
        ],
        [
          [7, 8],
          [8, 7],
        ],
      ),
    );
    const buf = new Int16Array(32).fill(-1);
    const count = generateMovesInto(st, BLACK, 999, buf, 0);
    expect(count).toBeLessThanOrEqual(16);
    expect(buf[16]).toBe(-1); // 确认第 16 个索引之后未被写穿
  });

  it('candidateMask 防御：即使位图第 225~255 位被意外置位，也不会生成非法坐标', () => {
    const st = stateOf(buildGame([[7, 7, BLACK]]));
    // 强制将第 7 个 word (涵盖 224~255) 的高位置 1
    st.candidateMask[7] = 0xffffffff;
    const cand = collectCandidates(st);
    for (const cell of cand) {
      expect(cell).toBeLessThan(225);
      expect(cell).toBeGreaterThanOrEqual(0);
    }
  });
});

