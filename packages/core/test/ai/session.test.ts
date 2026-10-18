/**
 * 会话（分片）测试：时间预算、可中断、确定性、abort 语义、节点预算兜底。
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  createSearchSession,
  type AiOptions,
  type GameState,
  type PlayerColor,
  type Point,
} from '../../src/index';
import { buildAlternating } from './helpers';

/**
 * 安静局面：只有零散子力，没有任何冲四/成五手。
 * 之所以要「安静」：算杀（VCF）同样消耗时间预算，而假时钟下每次读时钟都要计费；
 * 局面里若有冲四手，预算会在进入主搜索前就被算杀吃掉，测不出分片行为。
 */
const QUIET: GameState = buildAlternating(
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
const QUIET_COLOR: PlayerColor = BLACK;

/** 假时钟：每次读取前进 8ms，完全确定性 */
function fakeClock(stepMs = 8): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

function drain(s: ReturnType<typeof createSearchSession>): number {
  let slices = 0;
  while (s.step()) {
    slices += 1;
    if (slices > 10000) break;
  }
  return slices;
}

describe('时间预算（注入 now）', () => {
  it('超出预算时返回 false 且 cutoff === time', () => {
    const s = createSearchSession(QUIET, QUIET_COLOR, {
      difficulty: 'hard',
      timeBudgetMs: 60,
      now: fakeClock(8),
    });
    // 一大片：不受分片限制，只会被总预算打断
    const more = s.step(1000);
    expect(more).toBe(false);
    const st = s.stats();
    expect(st.cutoff).toBe('time');
    expect(st.elapsedMs).toBeGreaterThanOrEqual(60);
  });

  it('小分片下 step 会返回 true 多次（分片确实可中断）', () => {
    const s = createSearchSession(QUIET, QUIET_COLOR, {
      difficulty: 'hard',
      timeBudgetMs: 120,
      now: fakeClock(8),
    });
    const slices = drain(s);
    expect(slices).toBeGreaterThanOrEqual(2);
    expect(s.stats().cutoff).toBe('time');
  });

  it('即使中途被打断，result 仍返回已完成层的最优解', () => {
    const s = createSearchSession(QUIET, QUIET_COLOR, {
      difficulty: 'hard',
      timeBudgetMs: 120,
      now: fakeClock(8),
    });
    drain(s);
    const mv = s.result();
    expect(mv).not.toBeNull();
    if (mv !== null) expect(QUIET.board[mv[1]]?.[mv[0]]).toBe(0);
    expect(s.stats().depth).toBeGreaterThan(0);
  });
});

describe('节点预算（不注入 now 的兜底）', () => {
  it('按 maxNodes 收敛，cutoff === nodes', () => {
    const s = createSearchSession(QUIET, QUIET_COLOR, { difficulty: 'hard', maxNodes: 400 });
    drain(s);
    const st = s.stats();
    expect(st.cutoff).toBe('nodes');
    expect(st.nodes).toBeGreaterThanOrEqual(400);
    expect(st.elapsedMs).toBe(0);
  });

  it('无 now 时 step 一次跑完（不做无意义分片）', () => {
    const s = createSearchSession(QUIET, QUIET_COLOR, { difficulty: 'hard', maxNodes: 400 });
    expect(s.step()).toBe(false);
  });
});

describe('确定性', () => {
  it('同局面同参数连跑 5 次 result 完全相同', () => {
    const opts: AiOptions = { difficulty: 'hard', maxNodes: 400 };
    const results: (Point | null)[] = [];
    for (let i = 0; i < 5; i += 1) {
      const s = createSearchSession(QUIET, QUIET_COLOR, opts);
      drain(s);
      results.push(s.result());
    }
    const first = results[0];
    expect(first).not.toBeNull();
    for (const r of results) expect(r).toEqual(first);
  });

  it('分片大小不影响已完成层的解（大分片与小分片同解）', () => {
    const coarse = createSearchSession(QUIET, QUIET_COLOR, { difficulty: 'easy' });
    while (coarse.step(1000)) {
      // 一大片跑完
    }
    const fine = createSearchSession(QUIET, QUIET_COLOR, { difficulty: 'easy' });
    while (fine.step(4)) {
      // 多片跑完
    }
    expect(fine.result()).toEqual(coarse.result());
  });
});

describe('abort 语义', () => {
  it('abort 后 cutoff === aborted，result 保留已完成层解', () => {
    const s = createSearchSession(QUIET, QUIET_COLOR, {
      difficulty: 'hard',
      timeBudgetMs: 120,
      now: fakeClock(8),
    });
    expect(s.step(10)).toBe(true); // 还有剩余工作
    s.abort();
    expect(s.stats().cutoff).toBe('aborted');
    expect(s.result()).not.toBeNull();
    expect(s.step()).toBe(false);
  });

  it('预算不足一层时仍返回合法兜底点，深度保持 0', () => {
    const s = createSearchSession(QUIET, QUIET_COLOR, { difficulty: 'hard', maxNodes: 2 });
    drain(s);
    const move = s.result();
    expect(move).not.toBeNull();
    if (move !== null) expect(QUIET.board[move[1]]?.[move[0]]).toBe(0);
    expect(s.stats().depth).toBe(0);
  });
});

describe('算杀也遵守分片预算', () => {
  it('极小分片仍然推进工作，不会空转直到总预算耗尽', () => {
    const session = createSearchSession(QUIET, BLACK, {
      difficulty: 'hard', maxNodes: 400, now: fakeClock(1), timeBudgetMs: 10000,
    });
    expect(session.step(1)).toBe(true);
    expect(session.stats().nodes).toBeGreaterThan(0);
    session.abort();
  });

  it('大量独立冲四不能占满首片，暂停后不污染输入', () => {
    const black: Point[] = [];
    const white: Point[] = [];
    for (const y of [1, 5, 9, 13]) {
      for (const x of [1, 9]) {
        black.push([x, y], [x + 1, y], [x + 2, y]);
        white.push([x - 1, y]);
      }
    }
    for (const y of [0, 2, 4, 6, 8, 10, 12, 14]) white.push([6, y], [14, y]);
    const game = buildAlternating(black, white);
    const before = JSON.stringify(game);
    let clock = 0;
    const s = createSearchSession(game, BLACK, {
      difficulty: 'hard', timeBudgetMs: 10000, now: () => ++clock,
    });
    const start = clock;
    expect(s.step(8)).toBe(true);
    expect(clock - start).toBeLessThanOrEqual(10);
    expect(s.stats().nodes).toBeLessThan(6000);
    s.abort();
    expect(JSON.stringify(game)).toBe(before);
  });

  it('时间在算杀期间耗尽，仍能落子而不丢失 AI 回合', () => {
    const s = createSearchSession(QUIET, BLACK, {
      difficulty: 'hard', timeBudgetMs: 1, now: fakeClock(8),
    });
    expect(s.step()).toBe(false);
    expect(s.result()).not.toBeNull();
    expect(s.stats().cutoff).toBe('time');
    expect(s.stats().depth).toBe(0);
  });
});

describe('非法输入降级为安全空会话', () => {
  it('终局/尺寸不符/轮次不符均返回 null 且不抛', () => {
    const over = buildAlternating(
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
    expect(over.over).toBe(true);
    const s1 = createSearchSession(over, BLACK);
    expect(s1.step()).toBe(false);
    expect(s1.result()).toBeNull();
    expect(s1.stats().cutoff).toBe('none');

    const wrongSize: GameState = { ...buildAlternating([], []), size: 14 };
    expect(createSearchSession(wrongSize, BLACK).result()).toBeNull();

    const wrongTurn = buildAlternating([[7, 7]], []);
    // 只有 1 手棋 => 轮到白方，让黑方落子属于非法输入
    expect(createSearchSession(wrongTurn, BLACK).result()).toBeNull();
  });
});
