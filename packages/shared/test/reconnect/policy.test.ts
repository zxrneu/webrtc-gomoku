import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, nextDelayMs, totalWindowMs } from '../../src/reconnect/policy';

/** 固定随机源：语义同 Math.random（返回 [0,1)） */
const fixed = (v: number) => () => v;

describe('policy · 退避纯函数', () => {
  it('nextDelayMs(1..6) 在 random=0.5 时等于 500/1000/2000/4000/8000/16000', () => {
    const seq = [1, 2, 3, 4, 5, 6].map((attempt) =>
      nextDelayMs(attempt, DEFAULT_POLICY, fixed(0.5))
    );

    expect(seq).toEqual([500, 1000, 2000, 4000, 8000, 16000]);
  });

  it('jitter 下界：random=0 时退避为基准值的 0.8 倍', () => {
    expect(nextDelayMs(1, DEFAULT_POLICY, fixed(0))).toBe(400);
    expect(nextDelayMs(4, DEFAULT_POLICY, fixed(0))).toBe(3200);
  });

  it('jitter 上界：random→1 时退避为基准值的 1.2 倍', () => {
    expect(nextDelayMs(1, DEFAULT_POLICY, fixed(0.9999999))).toBe(600);
    expect(nextDelayMs(3, DEFAULT_POLICY, fixed(0.9999999))).toBe(2400);
  });

  it('第 6 次退避（含 jitter 上界）不超过 capDelayMs', () => {
    expect(nextDelayMs(6, DEFAULT_POLICY, fixed(0.9999999))).toBe(DEFAULT_POLICY.capDelayMs);
    expect(nextDelayMs(6, DEFAULT_POLICY, fixed(0.5))).toBe(DEFAULT_POLICY.capDelayMs);
  });

  it('attempt <= 0 被钳制为 1（防御性处理）', () => {
    expect(nextDelayMs(0, DEFAULT_POLICY, fixed(0.5))).toBe(500);
    expect(nextDelayMs(-3, DEFAULT_POLICY, fixed(0.5))).toBe(500);
  });

  it('random 越界时被钳制到 [0,1]，不产生负数或超过 1.2 倍的退避', () => {
    expect(nextDelayMs(1, DEFAULT_POLICY, fixed(-5))).toBe(400);
    expect(nextDelayMs(1, DEFAULT_POLICY, fixed(9))).toBe(600);
  });

  it('totalWindowMs 落在 PRD 窗口口径内（45s ~ 60s）', () => {
    const total = totalWindowMs(DEFAULT_POLICY);

    expect(total).toBeGreaterThanOrEqual(45000);
    expect(total).toBeLessThanOrEqual(60000);
    // Σ(500,1000,2000,4000,8000,16000)=31500 + 5 次连接超时 5×5000=25000 → 56500
    expect(total).toBe(56500);
  });

  it('DEFAULT_POLICY 的取值与设计文档 K4 完全一致', () => {
    expect(DEFAULT_POLICY.baseDelayMs).toBe(500);
    expect(DEFAULT_POLICY.capDelayMs).toBe(16000);
    expect(DEFAULT_POLICY.maxAttempts).toBe(6);
    expect(DEFAULT_POLICY.jitterRatio).toBe(0.2);
    expect(DEFAULT_POLICY.connectTimeoutMs).toBe(5000);
    expect(DEFAULT_POLICY.debounceMs).toBe(1000);
    expect(DEFAULT_POLICY.incidentSettleMs).toBe(10000);
    expect(DEFAULT_POLICY.wsHeartbeat).toEqual({ intervalMs: 5000, timeoutMs: 3000, misses: 2 });
    expect(DEFAULT_POLICY.p2p.disconnectedGraceMs).toBe(5000);
    expect(DEFAULT_POLICY.p2p.dcHeartbeat).toEqual({ intervalMs: 5000, timeoutMs: 3000, misses: 2 });
    expect(DEFAULT_POLICY.p2p.iceRestartAttempts).toBe(2);
    expect(DEFAULT_POLICY.p2p.iceRestartDelaysMs).toEqual([0, 3000]);
    expect(DEFAULT_POLICY.p2p.rebuildAttempts).toBe(1);
    expect(DEFAULT_POLICY.p2p.peerOnlineWaitMs).toBe(3000);
    expect(DEFAULT_POLICY.serverGraceSecs).toBe(60);
    expect(DEFAULT_POLICY.syncOnRestore).toBe(true);
  });
});
