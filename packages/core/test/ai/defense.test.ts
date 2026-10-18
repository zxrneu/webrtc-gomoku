import { describe, expect, it } from 'vitest';
import {
  BLACK, WHITE, applyMove, createSearchSession, verifyWinningProof,
  type GameState, type Point,
} from '../../src/index';
import { buildAlternating, cloneGame, opponentStillWins } from './helpers';

function counterKillPosition(): GameState {
  return buildAlternating(
    [[7, 7], [2, 8], [3, 8], [4, 6], [4, 7], [0, 0]],
    [[8, 8], [9, 8], [10, 8], [10, 9], [11, 9], [11, 11]],
  );
}

function finish(game: GameState, options: { maxNodes?: number; maxDepth?: number } = {}) {
  const session = createSearchSession(game, BLACK, { difficulty: 'hard', ...options });
  while (session.step()) { /* 完成搜索 */ }
  return session;
}

describe('最强档的反杀防守', () => {
  it('固定棋谱中的贪心堵点确实让白棋连续冲四取胜', () => {
    const game = counterKillPosition();
    expect(applyMove(game, 7, 8, BLACK).ok).toBe(true);
    expect(verifyWinningProof(game, WHITE, {
      kind: 'force', at: 8 * 15 + 11, reply: 8 * 15 + 12,
      next: { kind: 'fork', at: 10 * 15 + 11 },
    })).toBe(true);
  });

  it('主搜索仅剩一个节点也先排除会送给白棋连杀的兜底手', () => {
    const game = counterKillPosition();
    const session = finish(game, { maxNodes: 1 });
    expect(session.result()).toEqual([11, 8]);
    expect(opponentStillWins(game, session.result()!, BLACK, 5)).toBe(false);
  });

  it('主搜索深度为零时仍保留反杀检查得到的防守手', () => {
    expect(finish(counterKillPosition(), { maxDepth: 0 }).result()).toEqual([11, 8]);
  });

  it.each([1, 2, 3])('棋盘旋转 %i 个直角后仍避开同一条连杀', (turns) => {
    const rotate = ([x, y]: Point): Point => {
      let point: Point = [x, y];
      for (let i = 0; i < turns; i += 1) point = [14 - point[1], point[0]];
      return point;
    };
    const game = counterKillPosition();
    const black = game.moves.filter((move) => move.c === BLACK).map((move) => rotate([move.x, move.y]));
    const white = game.moves.filter((move) => move.c === WHITE).map((move) => rotate([move.x, move.y]));
    expect(finish(buildAlternating(black, white), { maxNodes: 1 }).result()).toEqual(rotate([11, 8]));
  });

  it('防住当前连杀不等于证明黑棋整局必胜，也不修改输入棋局', () => {
    const game = counterKillPosition();
    const before = cloneGame(game);
    const session = finish(game, { maxNodes: 1 });
    expect(session.stats().proofStatus).toBe('unknown');
    expect(session.stats().winningProof).toBeUndefined();
    expect(session.stats().depth).toBe(0);
    expect(game).toEqual(before);
  });

  it('反杀检查可以分片恢复，结果与不分片一致', () => {
    const game = counterKillPosition();
    let clock = 0;
    const session = createSearchSession(game, BLACK, {
      difficulty: 'hard', maxNodes: 1, timeBudgetMs: 100000, now: () => ++clock,
    });
    let slices = 0;
    while (session.step(1)) slices += 1;
    expect(slices).toBeGreaterThan(0);
    expect(session.result()).toEqual([11, 8]);
    expect(session.result()).toEqual(finish(game, { maxNodes: 1 }).result());
  });

  it('所有堵点都被证明会输时仍返回合法落子', () => {
    const game = buildAlternating(
      [[7, 7], [0, 0], [0, 3], [0, 6]],
      [[5, 9], [6, 9], [7, 9], [8, 9]],
    );
    const session = finish(game, { maxNodes: 1 });
    const move = session.result();
    expect(move).not.toBeNull();
    if (move) expect(applyMove(cloneGame(game), move[0], move[1], BLACK).ok).toBe(true);
    expect(session.stats().proofStatus).toBe('unknown');
  });
});
