/**
 * 搜索行为测试：赢棋/堵棋优先级、确定性、统计字段。
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  applyMove,
  createSearchSession,
  findBestMove,
  winLineAt,
  type GameState,
  type PlayerColor,
  type Point,
} from '../../src/index';
import { buildAlternating, cloneGame, winsAfterMove } from './helpers';

/** 判定「在这个点落子是否立刻成五」 */
function winsAt(g: GameState, mv: Point, color: PlayerColor): boolean {
  const work = cloneGame(g);
  const r = applyMove(work, mv[0], mv[1], color);
  return r.ok && r.event === 'win' && winLineAt(work, mv[0], mv[1], color) !== null;
}

describe('findBestMove：硬规则优先级', () => {
  it('己方有成五点时必须直接成五（不送棋的第一层）', () => {
    const g = buildAlternating(
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
    const mv = findBestMove(g, BLACK, { maxNodes: 800 });
    expect(mv).not.toBeNull();
    if (mv === null) return;
    // 一步成五必须被直接走掉，不允许绕道
    expect(winsAt(g, mv, BLACK)).toBe(true);
  });

  it('对方有成五点时必须堵（不送棋的第二层）', () => {
    const g = buildAlternating(
      [
        [2, 9],
        [0, 2],
        [0, 4],
        [14, 14],
      ],
      [
        [3, 9],
        [4, 9],
        [5, 9],
        [6, 9],
      ],
    );
    expect(findBestMove(g, BLACK, { maxNodes: 800 })).toEqual([7, 9]);
  });

  it('己方能成五时不去堵对方的成五点（先赢）', () => {
    const g = buildAlternating(
      [
        [3, 7],
        [4, 7],
        [5, 7],
        [6, 7],
      ],
      [
        [3, 9],
        [4, 9],
        [5, 9],
        [6, 9],
      ],
    );
    const mv = findBestMove(g, BLACK, { maxNodes: 800 });
    expect(mv).not.toBeNull();
    if (mv === null) return;
    // 双四与直接成五都能赢，但必须是赢棋手
    expect(winsAt(g, mv, BLACK) || winsAfterMove(g, mv, BLACK, 3)).toBe(true);
  });

  it('空盘执黑走开局点 (7,7)', () => {
    const g = buildAlternating([], []);
    expect(findBestMove(g, BLACK)).toEqual([7, 7]);
  });
});

describe('findBestMove：确定性（同局面必同输出）', () => {
  const g = buildAlternating(
    [
      [7, 7],
      [8, 8],
      [6, 6],
    ],
    [
      [7, 8],
      [6, 7],
      [9, 9],
    ],
  );

  it('同一局面同参数连跑 5 次结果完全一致', () => {
    const runs: (Point | null)[] = [];
    for (let i = 0; i < 5; i += 1) runs.push(findBestMove(g, BLACK, { maxNodes: 400 }));
    const first = runs[0];
    expect(first).not.toBeNull();
    for (const r of runs) expect(r).toEqual(first);
  });

  it('返回的落点一定在棋盘内且为空点', () => {
    const mv = findBestMove(g, BLACK, { maxNodes: 400 });
    expect(mv).not.toBeNull();
    if (mv === null) return;
    expect(mv[0]).toBeGreaterThanOrEqual(0);
    expect(mv[0]).toBeLessThan(15);
    expect(mv[1]).toBeGreaterThanOrEqual(0);
    expect(mv[1]).toBeLessThan(15);
    expect(g.board[mv[1]]?.[mv[0]]).toBe(0);
  });

  it('同一局面执白与执黑给出各自的合法解', () => {
    const g2 = buildAlternating(
      [
        [7, 7],
        [8, 8],
      ],
      [[7, 8]],
    );
    const mv = findBestMove(g2, WHITE, { maxNodes: 800 });
    expect(mv).not.toBeNull();
    if (mv !== null) expect(g2.board[mv[1]]?.[mv[0]]).toBe(0);
  });
});

describe('搜索统计', () => {
  it('完成迭代加深后 depth > 0、cutoff 为 depth、节点数 > 0', () => {
    const g = buildAlternating(
      [
        [7, 7],
        [8, 8],
        [6, 6],
      ],
      [
        [7, 8],
        [6, 7],
        [9, 9],
      ],
    );
    const s = createSearchSession(g, BLACK, { difficulty: 'easy' });
    while (s.step()) {
      // 跑完所有分片
    }
    const st = s.stats();
    expect(st.depth).toBeGreaterThan(0);
    expect(st.depth).toBeLessThanOrEqual(2);
    expect(st.cutoff).toBe('depth');
    expect(st.nodes).toBeGreaterThan(0);
    expect(st.elapsedMs).toBe(0); // 无 now 时恒为 0
    expect(st.fromOpening).toBe(false);
  });

  it('开局策略命中时 fromOpening 为 true', () => {
    const s = createSearchSession(buildAlternating([], []), BLACK);
    expect(s.step()).toBe(false);
    expect(s.stats().fromOpening).toBe(true);
    expect(s.result()).toEqual([7, 7]);
  });
});

describe('主搜索集成可验证的威胁证明', () => {
  it('困难档识别双活三，返回独立检查器认可的证明', async () => {
    const { verifyWinningProof } = await import('../../src/index');
    const game = buildAlternating([[5, 7], [6, 7], [7, 5], [7, 6]], [[0, 0], [0, 2], [14, 14], [14, 12]]);
    const session = createSearchSession(game, BLACK, { difficulty: 'hard' });
    while (session.step()) { /* 跑完可恢复的搜索 */ }
    expect(session.stats().proofStatus).toBe('win');
    expect(verifyWinningProof(game, BLACK, session.stats().winningProof)).toBe(true);
    expect(session.result()).toEqual([7, 7]);
  });

  it('天元开局不冒充已搜索 12 层或已经证明整局必胜', () => {
    const session = createSearchSession(buildAlternating([], []), BLACK);
    expect(session.stats().depth).toBe(0);
    expect(session.stats().proofStatus).toBe('unknown');
    expect(session.stats().winningProof).toBeUndefined();
  });
});
