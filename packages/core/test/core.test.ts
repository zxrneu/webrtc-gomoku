import { describe, it, expect } from 'vitest';
import {
  create,
  currentColor,
  applyMove,
  BLACK,
  WHITE,
  undo,
} from '../src/index';

describe('Gomoku Core Logic', () => {
  it('黑方先行', () => {
    const g = create();
    expect(currentColor(g)).toBe(BLACK);
  });

  it('轮流落子与占位校验', () => {
    const g = create();
    expect(applyMove(g, 7, 7, WHITE).ok).toBe(false); // 白方不能先走
    expect(applyMove(g, 7, 7, BLACK).ok).toBe(true);
    const occupied = applyMove(g, 7, 7, WHITE);
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) {
      expect(occupied.reason).toBe('occupied');
    }
    expect(currentColor(g)).toBe(WHITE);
  });

  it('越界落子被拒绝', () => {
    const g = create();
    const r1 = applyMove(g, -1, 0, BLACK);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('out-of-board');

    const r2 = applyMove(g, 15, 15, BLACK);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('out-of-board');
  });

  it('横向五连胜', () => {
    const g = create();
    for (let i = 0; i < 4; i++) {
      applyMove(g, i, 7, BLACK);
      applyMove(g, i, 8, WHITE);
    }
    const r = applyMove(g, 4, 7, BLACK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event).toBe('win');
      if (r.event === 'win') {
        expect(r.winner).toBe(BLACK);
        expect(r.line.length).toBe(5);
      }
    }
    expect(g.over).toBe(true);
  });

  it('竖向五连胜', () => {
    const g = create();
    for (let i = 0; i < 4; i++) {
      applyMove(g, 5, i, BLACK);
      applyMove(g, 6, i, WHITE);
    }
    const r = applyMove(g, 5, 4, BLACK);
    expect(r.ok).toBe(true);
    if (r.ok && r.event === 'win') {
      expect(r.winner).toBe(BLACK);
    }
  });

  it('斜向五连胜', () => {
    const g = create();
    for (let i = 0; i < 4; i++) {
      applyMove(g, i, i, BLACK);
      applyMove(g, 14 - i, i, WHITE);
    }
    const r = applyMove(g, 4, 4, BLACK);
    expect(r.ok).toBe(true);
    if (r.ok && r.event === 'win') {
      expect(r.winner).toBe(BLACK);
    }
  });

  it('长连（六子）也算胜利', () => {
    const g = create();
    const seq: [number, number, typeof BLACK | typeof WHITE][] = [
      [0, 7, BLACK],
      [10, 0, WHITE],
      [1, 7, BLACK],
      [10, 2, WHITE],
      [2, 7, BLACK],
      [10, 4, WHITE],
      [4, 7, BLACK],
      [10, 6, WHITE],
      [5, 7, BLACK],
      [10, 8, WHITE],
    ];
    for (const [x, y, c] of seq) applyMove(g, x, y, c);
    expect(g.over).toBe(false);
    const r = applyMove(g, 3, 7, BLACK);
    expect(r.ok).toBe(true);
    if (r.ok && r.event === 'win') {
      expect(r.winner).toBe(BLACK);
      expect(r.line.length).toBe(6);
    }
  });

  it('四子不判胜', () => {
    const g = create();
    for (let i = 0; i < 4; i++) applyMove(g, i, 7, BLACK);
    expect(g.over).toBe(false);
  });

  it('结束后不能再落子', () => {
    const g = create();
    for (let i = 0; i < 4; i++) {
      applyMove(g, i, 7, BLACK);
      applyMove(g, i, 8, WHITE);
    }
    applyMove(g, 4, 7, BLACK); // 黑胜
    const r = applyMove(g, 4, 8, WHITE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('game-over');
  });

  it('悔棋恢复回合', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK);
    applyMove(g, 7, 8, WHITE);
    expect(g.moves.length).toBe(2);
    expect(currentColor(g)).toBe(BLACK);

    const m = undo(g);
    expect(m?.x).toBe(7);
    expect(m?.y).toBe(8);
    expect(g.moves.length).toBe(1);
    expect(currentColor(g)).toBe(WHITE);
    expect(g.board[8]?.[7]).toBe(0);
  });
});
