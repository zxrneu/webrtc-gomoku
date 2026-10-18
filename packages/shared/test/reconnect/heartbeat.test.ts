import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../../src/reconnect/policy';
import { createHeartbeat, evaluate, markPong, markSent } from '../../src/reconnect/heartbeat';

const CFG = DEFAULT_POLICY.wsHeartbeat;

describe('heartbeat · 纯判定', () => {
  it('初始状态（无在途探测、无 pong）判为 due，可立即发第一次探测', () => {
    const s = createHeartbeat(0);

    expect(evaluate(s, 0, CFG)).toEqual({ verdict: 'due', state: s });
  });

  it('在途探测未回时不发第二次（单飞）', () => {
    const sent = markSent(createHeartbeat(0), 0);

    const result = evaluate(sent, 1000, CFG);

    expect(result.verdict).toBe('waiting');
    expect(result.state).toBe(sent);
  });

  it('一次超时只记 1 次 miss，不判死', () => {
    const sent = markSent(createHeartbeat(0), 0);

    const result = evaluate(sent, CFG.timeoutMs, CFG);

    expect(result.verdict).toBe('miss');
    expect(result.state.misses).toBe(1);
    expect(result.state.pendingSinceMs).toBeNull();
  });

  it('间隔 5s + 两次 3s 超时后判定 dead（最坏 11s，加 tick 抖动 ≤16s，对齐 M4）', () => {
    // 推导：pong@0 → 5000 发第二次探测 → 8000 第一次超时 → 再发 → 11000 第二次超时 → dead
    let s = markPong(markSent(createHeartbeat(0), 0), 0);

    const idleAt1000 = evaluate(s, 1000, CFG);
    expect(idleAt1000.verdict).toBe('idle');

    const dueAt5000 = evaluate(s, CFG.intervalMs, CFG);
    expect(dueAt5000.verdict).toBe('due');

    s = markSent(dueAt5000.state, CFG.intervalMs);
    const firstMiss = evaluate(s, CFG.intervalMs + CFG.timeoutMs, CFG);
    expect(firstMiss.verdict).toBe('miss');
    expect(firstMiss.state.misses).toBe(1);

    const dueAgain = evaluate(firstMiss.state, CFG.intervalMs + CFG.timeoutMs, CFG);
    expect(dueAgain.verdict).toBe('due');

    s = markSent(dueAgain.state, CFG.intervalMs + CFG.timeoutMs);
    const dead = evaluate(s, CFG.intervalMs + CFG.timeoutMs * 2, CFG);
    expect(dead.verdict).toBe('dead');
    expect(dead.state.misses).toBe(2);
    expect(CFG.intervalMs + CFG.timeoutMs * 2).toBe(11000);
  });

  it('收到 pong 后 misses 归零且记录 lastPongAtMs', () => {
    const missed = evaluate(markSent(createHeartbeat(0), 0), CFG.timeoutMs, CFG).state;
    const ponged = markPong(missed, 4000);

    expect(ponged.misses).toBe(0);
    expect(ponged.lastPongAtMs).toBe(4000);
    expect(ponged.pendingSinceMs).toBeNull();
  });

  it('间隔未到时判为 idle（不提前发探测）', () => {
    const s = markPong(createHeartbeat(0), 0);

    expect(evaluate(s, CFG.intervalMs - 1, CFG).verdict).toBe('idle');
  });

  it('createHeartbeat 不读取全局时钟（纯函数，入参即时间）', () => {
    const a = createHeartbeat(1000);
    const b = createHeartbeat(9999);

    expect(a).toEqual({ pendingSinceMs: null, misses: 0, lastPongAtMs: null });
    expect(b).toEqual(a);
  });
});
