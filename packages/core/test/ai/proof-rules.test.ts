import { describe, expect, it } from 'vitest';
import { BLACK, create } from '../../src/index';
import { emptyCells, isProofGame, readProofBoard, winningCells, winsAt } from '../../src/ai/proofRules';
import { buildAlternating } from './helpers';

describe('证明使用独立的规则判定', () => {
  it('空点枚举包括远离棋子的所有合法应手', () => {
    const board = readProofBoard(buildAlternating([[7, 7]], []));
    expect(board).not.toBeNull();
    if (!board) return;
    expect(emptyCells(board)).toHaveLength(224);
    expect(emptyCells(board)).toContain(0);
  });
  it('独立规则识别跳空补成长连，不改变输入', () => {
    const game = buildAlternating([[2, 7], [3, 7], [4, 7], [6, 7], [7, 7]],
      [[0, 0], [0, 2], [0, 4], [14, 14], [14, 12]]);
    const board = readProofBoard(game);
    expect(board).not.toBeNull();
    if (!board) return;
    const before = board.slice();
    expect(winningCells(board, BLACK)).toContain(7 * 15 + 5);
    expect(board).toEqual(before);
    board[7 * 15 + 5] = BLACK;
    expect(winsAt(board, 7 * 15 + 5, BLACK)).toBe(true);
  });
  it('拒绝棋盘棋谱不一致、重复落子、非整数坐标和已经结束的输入', () => {
    const game = create();
    expect(isProofGame(game)).toBe(true);
    expect(isProofGame(null)).toBe(false);
    expect(readProofBoard({ ...game, board: [] })).toBeNull();
    expect(readProofBoard({ ...game, moves: [{ x: 7.5, y: 7, c: BLACK }] })).toBeNull();
    expect(readProofBoard({ ...game, over: true })).toBeNull();
    const one = buildAlternating([[7, 7]], []);
    expect(readProofBoard({ ...one, moves: [...one.moves, ...one.moves] })).toBeNull();
  });
});
