/**
 * 对外门面测试：非法输入必须返回 null 且不抛异常（架构 §3 语义契约 3）。
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  applyMove,
  create,
  createSearchSession,
  evaluateBoard,
  findBestMove,
  type GameState,
} from '../../src/index';
import { buildAlternating } from './helpers';

describe('findBestMove 的非法输入处理', () => {
  it('game over 时返回 null 且不抛', () => {
    const g = buildAlternating(
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
    expect(g.over).toBe(true);
    expect(() => findBestMove(g, WHITE)).not.toThrow();
    expect(findBestMove(g, WHITE)).toBeNull();
  });

  it('棋盘尺寸不是 15 时返回 null', () => {
    const g = create();
    const bad: GameState = { ...g, size: 19 };
    expect(() => findBestMove(bad, BLACK)).not.toThrow();
    expect(findBestMove(bad, BLACK)).toBeNull();
  });

  it('落子记录与棋盘不一致（坐标已被占）时返回 null', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK);
    // 伪造：moves 声称 (8,8) 有白子，但棋盘上该点为空
    g.moves.push({ x: 8, y: 8, c: WHITE });
    expect(() => findBestMove(g, BLACK)).not.toThrow();
    expect(findBestMove(g, BLACK)).toBeNull();
  });

  it('重复坐标（同一点出现两次）时返回 null', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK);
    applyMove(g, 7, 8, WHITE);
    g.moves[1] = { x: 7, y: 7, c: WHITE };
    expect(findBestMove(g, BLACK)).toBeNull();
  });

  it('轮次与传入颜色不符时返回 null', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK);
    // 现在轮到白方，却让黑方落子
    expect(findBestMove(g, BLACK)).toBeNull();
  });

  it('棋盘与记录数量相同但落子没有黑白交替时拒绝搜索', () => {
    const game = create();
    game.moves.push({ x: 7, y: 7, c: WHITE });
    game.board[7]![7] = WHITE;
    expect(findBestMove(game, WHITE)).toBeNull();
  });

  it('伪造未结束标记不能让已成五的棋局继续搜索', () => {
    const game = buildAlternating(
      [[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]],
      [[0, 0], [0, 2], [14, 14], [14, 12]],
    );
    game.over = false;
    game.winLine = null;
    expect(findBestMove(game, WHITE)).toBeNull();
  });

  it('棋盘已满时返回 null', () => {
    const g = create();
    // 直接构造满盘（无需真实对局）
    for (let y = 0; y < 15; y += 1) {
      for (let x = 0; x < 15; x += 1) {
        const row = g.board[y];
        if (row) row[x] = (x + y) % 2 === 0 ? BLACK : WHITE;
        g.moves.push({ x, y, c: (x + y) % 2 === 0 ? BLACK : WHITE });
      }
    }
    expect(findBestMove(g, BLACK)).toBeNull();
  });

  it('createSearchSession 对非法输入返回安全空会话', () => {
    const g = create();
    const s = createSearchSession({ ...g, size: 3 }, BLACK);
    expect(s.step()).toBe(false);
    expect(s.result()).toBeNull();
    expect(s.stats().nodes).toBe(0);
    s.abort();
    expect(s.stats().cutoff).toBe('none');
  });
});

describe('合法输入的正常行为', () => {
  it('返回合法空点，且重复调用结果一致', () => {
    const g = buildAlternating(
      [
        [7, 7],
        [8, 8],
      ],
      [
        [7, 8],
        [8, 7],
      ],
    );
    const a = findBestMove(g, BLACK, { maxNodes: 600 });
    const b = findBestMove(g, BLACK, { maxNodes: 600 });
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    if (a !== null) expect(g.board[a[1]]?.[a[0]]).toBe(0);
  });

  it('evaluateBoard 对同一局面稳定且双方符号相反', () => {
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
    expect(evaluateBoard(g, BLACK)).toBe(evaluateBoard(g, BLACK));
    expect(evaluateBoard(g, BLACK)).toBeGreaterThan(0);
    expect(evaluateBoard(g, WHITE)).toBeLessThan(0);
  });

  it('findBestMove 不修改传入的棋局（纯函数语义）', () => {
    const g = buildAlternating(
      [
        [7, 7],
        [8, 8],
      ],
      [
        [7, 8],
        [8, 7],
      ],
    );
    const before = JSON.stringify(g);
    findBestMove(g, BLACK, { maxNodes: 400 });
    expect(JSON.stringify(g)).toBe(before);
  });
});
