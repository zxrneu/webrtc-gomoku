import { describe, expect, it } from 'vitest';
import { BLACK, WHITE, currentColor, findBestMove } from '@webrtc-gomoku/core';
import type { GameState } from '@webrtc-gomoku/core';

import {
  aiColorOf,
  canUndoPair,
  createAiGame,
  isPlayerTurn,
  lastMoveOf,
  playAiMove,
  playPlayerMove,
  stoneCount,
  undoPair,
} from '../src/ai/aiGame';

/**
 * 人机棋局纯函数层（T04 ①）
 *
 * 全部用例不启动浏览器、不依赖 @testing-library：
 * 棋局操作是纯函数，注入局面即可断言，毫秒级完成。
 */

/**
 * 交替落子到「正好轮到玩家」的局面（黑先），返回最终局面。
 *
 * 黑方玩家：AI（白）应手后即轮到玩家（手数为偶数）；
 * 白方玩家：AI（黑）先手，玩家每应一手 AI 再走一手才轮到玩家（手数为奇数）。
 */
function playSequence(playerColor: 1 | 2, pairs: number): GameState {
  const aiColor = aiColorOf(playerColor);
  let g = createAiGame();
  const blackPoints: [number, number][] = [
    [7, 7], [8, 8], [6, 6], [9, 9], [5, 5], [10, 10],
  ];
  const whitePoints: [number, number][] = [
    [0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [0, 14],
  ];
  for (let i = 0; i < pairs; i += 1) {
    const black = blackPoints[i];
    const white = whitePoints[i];
    if (black === undefined || white === undefined) break;
    const first = playerColor === BLACK ? playPlayerMove(g, black[0], black[1], playerColor) : playAiMove(g, black[0], black[1], aiColor);
    expect(first.ok).toBe(true);
    g = first.game;
    const second = playerColor === BLACK ? playAiMove(g, white[0], white[1], aiColor) : playPlayerMove(g, white[0], white[1], playerColor);
    expect(second.ok).toBe(true);
    g = second.game;
  }
  // 白方玩家还要等 AI 再应一手才轮到自己
  if (playerColor === WHITE) {
    const extra = playAiMove(g, 12, 12, aiColor);
    expect(extra.ok).toBe(true);
    g = extra.game;
  }
  return g;
}

describe('aiGame 建局与落子', () => {
  it('建局是空盘、黑先、未终局', () => {
    const g = createAiGame();
    expect(g.moves).toHaveLength(0);
    expect(g.over).toBe(false);
    expect(currentColor(g)).toBe(BLACK);
  });

  it('玩家落子后手数 +1，回合交给 AI', () => {
    const g = playPlayerMove(createAiGame(), 7, 7, BLACK);
    expect(g.ok).toBe(true);
    expect(g.game.moves).toHaveLength(1);
    expect(g.game.moves[0]).toEqual({ x: 7, y: 7, c: BLACK });
    expect(currentColor(g.game)).toBe(WHITE);
  });

  it('非玩家回合落子被拒，且棋局对象原样返回', () => {
    const g = playPlayerMove(createAiGame(), 7, 7, WHITE);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe('not-your-turn');
    expect(g.game.moves).toHaveLength(0);
  });

  it('已占点被拒（原因来自 core 的 applyMove）', () => {
    const first = playPlayerMove(createAiGame(), 7, 7, BLACK);
    const second = playAiMove(first.game, 7, 7, WHITE);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('occupied');
    expect(second.game.moves).toHaveLength(1);
  });

  it('操作是不可变的：旧棋局不会被改写', () => {
    const g = createAiGame();
    const next = playPlayerMove(g, 7, 7, BLACK);
    expect(g.moves).toHaveLength(0);
    expect(g.board[7]?.[7]).toBe(0);
    expect(next.game.board[7]?.[7]).toBe(BLACK);
    expect(next.game).not.toBe(g);
    expect(next.game.moves).not.toBe(g.moves);
  });

  it('胜负判定完全复用 core：五连时 event=win 且 over=true', () => {
    let g = createAiGame();
    const blackLine: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0]];
    const whiteLine: [number, number][] = [[0, 5], [1, 5], [2, 5], [3, 5]];
    for (let i = 0; i < blackLine.length; i += 1) {
      const black = blackLine[i]!;
      const white = whiteLine[i]!;
      g = playPlayerMove(g, black[0], black[1], BLACK).game;
      g = playAiMove(g, white[0], white[1], WHITE).game;
    }
    const final = playPlayerMove(g, 4, 0, BLACK);
    expect(final.ok).toBe(true);
    if (final.ok) expect(final.event).toBe('win');
    expect(final.game.over).toBe(true);
    expect(final.game.winLine?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});

describe('aiGame 思考期守卫（PRD P0-4）', () => {
  it('thinking 期间连点 10 次，手数一次都不变', () => {
    let g = playPlayerMove(createAiGame(), 7, 7, BLACK).game;
    const before = g.moves.length;
    for (let i = 0; i < 10; i += 1) {
      const attempt = playPlayerMove(g, i, 0, BLACK, true);
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.reason).toBe('thinking');
      expect(attempt.game).toBe(g);
      g = attempt.game;
    }
    expect(g.moves).toHaveLength(before);
  });

  it('思考期优先级高于终局与回合判断', () => {
    const g = playPlayerMove(createAiGame(), 7, 7, BLACK).game;
    const attempt = playPlayerMove(g, 0, 0, WHITE, true);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.reason).toBe('thinking');
  });
});

describe('aiGame AI 执黑开局', () => {
  it('AI 执黑、空盘时首手固定天元 (7,7)（PRD P0-9）', () => {
    const g = createAiGame();
    const move = findBestMove(g, BLACK, { difficulty: 'easy' });
    expect(move).toEqual([7, 7]);

    const applied = playAiMove(g, 7, 7, BLACK);
    expect(applied.ok).toBe(true);
    expect(applied.game.moves).toEqual([{ x: 7, y: 7, c: BLACK }]);
    expect(currentColor(applied.game)).toBe(WHITE);
  });

  it('玩家执白时 AI 先手落子后轮到玩家', () => {
    const g = playSequence(WHITE, 1);
    expect(g.moves[0]).toEqual({ x: 7, y: 7, c: BLACK });
    expect(isPlayerTurn(g, WHITE)).toBe(true);
    expect(stoneCount(g, WHITE)).toBe(1);
  });
});

describe('aiGame 悔棋（一次退两步）', () => {
  it('黑方玩家悔棋后手数 -2 且回到自己回合', () => {
    const g = playSequence(BLACK, 2);
    expect(g.moves).toHaveLength(4);
    expect(canUndoPair(g, BLACK)).toBe(true);

    const undone = undoPair(g, BLACK);
    expect(undone.moves).toHaveLength(2);
    expect(currentColor(undone)).toBe(BLACK);
    expect(isPlayerTurn(undone, BLACK)).toBe(true);
  });

  it('白方玩家悔棋后手数 -2 且回到自己回合', () => {
    const g = playSequence(WHITE, 2);
    expect(g.moves).toHaveLength(5);
    expect(canUndoPair(g, WHITE)).toBe(true);

    const undone = undoPair(g, WHITE);
    expect(undone.moves).toHaveLength(3);
    expect(currentColor(undone)).toBe(WHITE);
    expect(isPlayerTurn(undone, WHITE)).toBe(true);
  });

  it('手数 < 2 时不可悔棋', () => {
    const one = playPlayerMove(createAiGame(), 7, 7, BLACK).game;
    expect(canUndoPair(one, BLACK)).toBe(false);
    expect(undoPair(one, BLACK)).toBe(one);
  });

  it('我方还没落过子时不可悔棋（AI 刚走完首手）', () => {
    const g = playAiMove(createAiGame(), 7, 7, BLACK).game;
    expect(stoneCount(g, WHITE)).toBe(0);
    expect(canUndoPair(g, WHITE)).toBe(false);
  });

  it('思考期与终局都不可悔棋', () => {
    const g = playSequence(BLACK, 2);
    expect(canUndoPair(g, BLACK, true)).toBe(false);
    const over: GameState = { ...g, over: true };
    expect(canUndoPair(over, BLACK)).toBe(false);
  });

  it('悔棋是不可变的：原棋局保留全部手数', () => {
    const g = playSequence(BLACK, 2);
    const undone = undoPair(g, BLACK);
    expect(g.moves).toHaveLength(4);
    expect(undone.moves).toHaveLength(2);
    expect(g.board[7]?.[7]).toBe(BLACK);
  });
});

describe('aiGame 辅助函数', () => {
  it('aiColorOf 取反', () => {
    expect(aiColorOf(BLACK)).toBe(WHITE);
    expect(aiColorOf(WHITE)).toBe(BLACK);
  });

  it('lastMoveOf 取该方最后一手，没有则 null', () => {
    const g = playSequence(BLACK, 2);
    const aiLast = lastMoveOf(g, WHITE);
    expect(aiLast).toEqual({ x: 1, y: 1, c: WHITE });
    expect(lastMoveOf(createAiGame(), WHITE)).toBeNull();
  });
});
