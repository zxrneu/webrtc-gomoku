/**
 * 开局策略测试：空盘天元、中心 3×3 固定应答、其余交回搜索。
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  applyMove,
  create,
  createSearchSession,
  findBestMove,
  openingMove,
} from '../../src/index';

describe('openingMove', () => {
  it('空盘执黑必走天元 (7,7)', () => {
    const g = create();
    expect(openingMove(g, BLACK)).toEqual([7, 7]);
  });

  it('空盘执白不接手开局策略（白方不会先手）', () => {
    const g = create();
    expect(openingMove(g, WHITE)).toBeNull();
  });

  it('玩家首手在中心 3×3 时，白方在中心 3×3 内固定应答', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK);
    const mv = openingMove(g, WHITE);
    expect(mv).not.toBeNull();
    if (mv === null) return;
    expect(mv[0]).toBeGreaterThanOrEqual(6);
    expect(mv[0]).toBeLessThanOrEqual(8);
    expect(mv[1]).toBeGreaterThanOrEqual(6);
    expect(mv[1]).toBeLessThanOrEqual(8);
    // 不能落在已占的天元上
    expect(g.board[mv[1]]?.[mv[0]]).toBe(0);
  });

  it('中心 3×3 的 9 个首手都有确定性应答，且都落在中心区', () => {
    for (let y = 6; y <= 8; y += 1) {
      for (let x = 6; x <= 8; x += 1) {
        const g = create();
        applyMove(g, x, y, BLACK);
        const mv = openingMove(g, WHITE);
        expect(mv, `首手 (${x},${y}) 必须有应答`).not.toBeNull();
        if (mv === null) continue;
        expect(mv[0]).toBeGreaterThanOrEqual(6);
        expect(mv[0]).toBeLessThanOrEqual(8);
        expect(mv[1]).toBeGreaterThanOrEqual(6);
        expect(mv[1]).toBeLessThanOrEqual(8);
        expect(g.board[mv[1]]?.[mv[0]]).toBe(0);
      }
    }
  });

  it('玩家首手在中心 3×3 之外时返回 null（交给搜索）', () => {
    const g = create();
    applyMove(g, 0, 0, BLACK);
    expect(openingMove(g, WHITE)).toBeNull();
  });

  it('已过开局阶段时返回 null', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK);
    applyMove(g, 8, 8, WHITE);
    expect(openingMove(g, BLACK)).toBeNull();
  });
});

describe('开局策略与搜索的衔接', () => {
  it('findBestMove 在空盘直接给出 (7,7)', () => {
    expect(findBestMove(create(), BLACK)).toEqual([7, 7]);
  });

  it('AI 执白时首手应答命中开局策略（fromOpening = true）', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK);
    const s = createSearchSession(g, WHITE);
    expect(s.step()).toBe(false);
    expect(s.stats().fromOpening).toBe(true);
    expect(s.result()).not.toBeNull();
  });
});
