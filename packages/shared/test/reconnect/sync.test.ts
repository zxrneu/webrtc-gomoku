import { describe, expect, it } from 'vitest';
import type { Move } from '@webrtc-gomoku/core';

import { planSync, replayMoves } from '../../src/reconnect/sync';

const B = 1 as const;
const W = 2 as const;

/** 交替落子构造合法棋谱（黑先） */
function moves(...points: [number, number][]): Move[] {
  return points.map(([x, y], i) => ({ x, y, c: i % 2 === 0 ? B : W }));
}

describe('sync · replayMoves 确定性重放', () => {
  it.each([
    null,
    1,
    { x: '0', y: 0, c: 1 },
    { x: { valueOf: null, toString: null }, y: 0, c: 1 },
    { x: 0.5, y: 0, c: 1 },
    { x: 0, y: 0, c: 0 },
  ])('replayMoves 安全拒绝非法元素 %j', move => {
    const list = [{ x: 7, y: 7, c: 1 }, move] as unknown as Move[];
    expect(replayMoves(list)).toEqual({ ok: false, at: 1 });
  });

  it('合法棋谱重放成功且手数一致', () => {
    const list = moves([7, 7], [8, 8], [7, 8]);

    const result = replayMoves(list);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.game.moves).toHaveLength(3);
      expect(result.game.board[7]?.[7]).toBe(B);
      expect(result.game.board[8]?.[8]).toBe(W);
    }
  });

  it('replayMoves 遇到非法落子返回 {ok:false, at:3}（第 4 手落在已占位置）', () => {
    const list = moves([7, 7], [8, 8], [7, 8], [7, 7]);

    expect(replayMoves(list)).toEqual({ ok: false, at: 3 });
  });

  it('replayMoves 拒绝越界坐标', () => {
    const list = moves([7, 7], [99, 99]);

    expect(replayMoves(list)).toEqual({ ok: false, at: 1 });
  });

  it('replayMoves 拒绝颜色错序（黑先白后）的棋谱', () => {
    const list: Move[] = [{ x: 7, y: 7, c: W }];

    expect(replayMoves(list)).toEqual({ ok: false, at: 0 });
  });

  it('空棋谱重放得到空棋盘', () => {
    const result = replayMoves([]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.game.moves).toEqual([]);
      expect(result.game.over).toBe(false);
    }
  });
});

describe('sync · planSync 房主权威对账', () => {
  it('房主恒为权威方，adopt 为本地棋谱且不产生差异', () => {
    const local = moves([7, 7], [8, 8]);

    const plan = planSync({ role: 'host', local });

    expect(plan.authoritative).toBe(true);
    expect(plan.adopt).toEqual(local);
    expect(plan.appended).toBe(0);
    expect(plan.mismatch).toBe(false);
  });

  it('加入方本地是权威前缀时只追加差异，appended=2', () => {
    const local = moves([7, 7], [8, 8]);
    const incoming = moves([7, 7], [8, 8], [7, 8], [8, 7]);

    const plan = planSync({ role: 'guest', local, incoming });

    expect(plan.authoritative).toBe(false);
    expect(plan.adopt).toEqual(incoming);
    expect(plan.appended).toBe(2);
    expect(plan.mismatch).toBe(false);
  });

  it('加入方本地多出 1 手时整体替换为权威棋谱且 mismatch=true', () => {
    const local = moves([7, 7], [8, 8], [7, 8]);
    const incoming = moves([7, 7], [8, 8]);

    const plan = planSync({ role: 'guest', local, incoming });

    expect(plan.adopt).toEqual(incoming);
    expect(plan.appended).toBe(0);
    expect(plan.mismatch).toBe(true);
  });

  it('加入方分叉时以房主棋谱为准（adopt=incoming）', () => {
    const local = moves([7, 7], [8, 8], [6, 6]);
    const incoming = moves([7, 7], [8, 8], [7, 8]);

    const plan = planSync({ role: 'guest', local, incoming });

    expect(plan.adopt).toEqual(incoming);
    expect(plan.mismatch).toBe(true);
  });

  it('加入方本地为空时整体采纳权威棋谱', () => {
    const incoming = moves([7, 7], [8, 8]);

    const plan = planSync({ role: 'guest', local: [], incoming });

    expect(plan.adopt).toEqual(incoming);
    expect(plan.appended).toBe(2);
    expect(plan.mismatch).toBe(false);
  });

  it('加入方未收到 incoming 时保留本地棋谱', () => {
    const local = moves([7, 7]);

    const plan = planSync({ role: 'guest', local });

    expect(plan.adopt).toEqual(local);
    expect(plan.appended).toBe(0);
    expect(plan.mismatch).toBe(false);
  });

  it('加入方收到非法（脏）棋谱时拒绝采纳并标记 mismatch', () => {
    const local = moves([7, 7], [8, 8]);
    const incoming = moves([7, 7], [7, 7]);

    const plan = planSync({ role: 'guest', local, incoming });

    expect(plan.adopt).toEqual(local);
    expect(plan.appended).toBe(0);
    expect(plan.mismatch).toBe(true);
  });

  it('双方棋谱完全一致时无差异、无分叉', () => {
    const local = moves([7, 7], [8, 8], [7, 8]);

    const plan = planSync({ role: 'guest', local, incoming: moves([7, 7], [8, 8], [7, 8]) });

    expect(plan.adopt).toEqual(local);
    expect(plan.appended).toBe(0);
    expect(plan.mismatch).toBe(false);
  });
});
