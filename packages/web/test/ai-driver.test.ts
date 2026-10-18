import { describe, expect, it, vi } from 'vitest';
import type { AiOptions, GameState, PlayerColor } from '@webrtc-gomoku/core';
import { BLACK, WHITE } from '@webrtc-gomoku/core';

import { createAiGame, playAiMove, playPlayerMove } from '../src/ai/aiGame';
import { runSearchSharded } from '../src/ai/searchDriver';

/**
 * 分片调度器（T04 ②）
 *
 * 两个关键断言：
 * 1. **真的分片**：`step` 被调用 ≥2 次（不是一把梭跑完）；
 * 2. **可取消**：取消函数调用后 `onDone` 绝不再触发（否则卸载/悔棋后旧结果会踩掉新棋局）。
 *
 * 为了能观测 `step` 调用次数，这里对 core 做**薄包装**（原实现仍然执行，
 * 只是多记一次数），不改变任何搜索行为。
 */

const probe = vi.hoisted(() => ({ steps: 0 }));

vi.mock('@webrtc-gomoku/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@webrtc-gomoku/core')>();
  return {
    ...real,
    createSearchSession: (
      g: GameState,
      color: PlayerColor,
      opts?: AiOptions,
    ): ReturnType<typeof real.createSearchSession> => {
      const session = real.createSearchSession(g, color, opts);
      return {
        difficulty: session.difficulty,
        step: (budgetMs?: number): boolean => {
          probe.steps += 1;
          return session.step(budgetMs);
        },
        result: () => session.result(),
        stats: () => session.stats(),
        abort: () => session.abort(),
      };
    },
  };
});

/** 构造一个「非开局、非终局」的局面：AI（黑）该走 */
function midGame(): GameState {
  let g = createAiGame();
  g = playPlayerMove(g, 7, 7, BLACK).game;
  g = playAiMove(g, 8, 8, WHITE).game;
  return g;
}

/** 假的宏任务队列：不执行，由用例决定何时泵 */
function makeQueue() {
  const queue: (() => void)[] = [];
  return {
    queue,
    schedule: (cb: () => void): void => {
      queue.push(cb);
    },
    /** 逐个执行当前排队回调（模拟事件循环推进） */
    drain(maxRounds = 5000): void {
      let rounds = 0;
      while (queue.length > 0 && rounds < maxRounds) {
        const next = queue.shift();
        next?.();
        rounds += 1;
      }
    },
  };
}

describe('runSearchSharded 分片与取消', () => {
  it('真的分片：step 被调用 ≥2 次，onDone 只触发 1 次', () => {
    probe.steps = 0;
    const q = makeQueue();
    // 假时间源：每次读取前进 1ms，使「单片 4ms」在少量节点后就到点让出
    let clock = 0;
    const now = (): number => {
      clock += 1;
      return clock;
    };
    const done: { move: unknown; stats: unknown }[] = [];

    runSearchSharded(
      midGame(),
      BLACK,
      { difficulty: 'hard', timeBudgetMs: 40, maxDepth: 12, maxNodes: 10_000_000 },
      { sliceMs: 4, now, schedule: q.schedule },
      (move, stats) => done.push({ move, stats }),
    );

    // 首片被 schedule 推迟：此刻还没开始搜索
    expect(probe.steps).toBe(0);
    q.drain();

    expect(probe.steps).toBeGreaterThanOrEqual(2);
    expect(done).toHaveLength(1);
    expect(Array.isArray(done[0]?.move)).toBe(true);
  });

  it('取消后不再触发 onDone（首片之前取消）', () => {
    probe.steps = 0;
    const q = makeQueue();
    let clock = 0;
    const done = vi.fn();

    const cancel = runSearchSharded(
      midGame(),
      BLACK,
      { difficulty: 'hard', timeBudgetMs: 40, maxDepth: 12, maxNodes: 10_000_000 },
      { sliceMs: 4, now: () => { clock += 1; return clock; }, schedule: q.schedule },
      done,
    );

    cancel();
    q.drain();

    expect(probe.steps).toBe(0);
    expect(done).not.toHaveBeenCalled();
  });

  it('取消后不再触发 onDone（搜索进行中取消）', () => {
    probe.steps = 0;
    const q = makeQueue();
    let clock = 0;
    const done = vi.fn();

    const cancel = runSearchSharded(
      midGame(),
      BLACK,
      { difficulty: 'hard', timeBudgetMs: 400, maxDepth: 12, maxNodes: 10_000_000 },
      { sliceMs: 2, now: () => { clock += 1; return clock; }, schedule: q.schedule },
      done,
    );

    // 只泵两轮就取消：此时搜索必然还没结束
    q.queue.shift()?.();
    q.queue.shift()?.();
    cancel();
    q.drain();

    expect(probe.steps).toBeGreaterThanOrEqual(1);
    expect(done).not.toHaveBeenCalled();
  });

  it('重复调用取消函数是幂等的', () => {
    const q = makeQueue();
    const done = vi.fn();
    let clock = 0;
    const cancel = runSearchSharded(
      midGame(),
      BLACK,
      { difficulty: 'easy' },
      { sliceMs: 4, now: () => { clock += 1; return clock; }, schedule: q.schedule },
      done,
    );
    cancel();
    cancel();
    q.drain();
    expect(done).not.toHaveBeenCalled();
  });

  it('终局局面：onDone 收到 null（core 用空会话降级，不抛异常）', () => {
    const q = makeQueue();
    const over: GameState = { ...midGame(), over: true };
    const done = vi.fn();
    let clock = 0;

    runSearchSharded(
      over,
      BLACK,
      { difficulty: 'easy' },
      { sliceMs: 4, now: () => { clock += 1; return clock; }, schedule: q.schedule },
      done,
    );
    q.drain();

    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0]?.[0]).toBeNull();
  });
});
