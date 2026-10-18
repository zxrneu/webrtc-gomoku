import { describe, expect, it } from 'vitest';

import { SeatRegistry } from '../src/grace';

const GRACE_MS = 60000;

/** 固定序列 token 生成器：t1 / t2 / t3 … */
function counterTokens(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `token-${n}`;
  };
}

function createRegistry(): SeatRegistry {
  return new SeatRegistry({ graceMs: GRACE_MS, newToken: counterTokens() });
}

describe('grace · 座位登记与凭证', () => {
  it('issue 后座位数为 1，且下发的 token 可校验通过', () => {
    const reg = createRegistry();

    const token = reg.issue('p1', 'A8B2', '房主', 'host', 0);

    expect(reg.size).toBe(1);
    expect(token).toBe('token-1');
    expect(reg.verify('p1', 'A8B2', token, 0)).toBe('ok');
  });

  it('未登记的 peerId 校验结果为 unknown', () => {
    const reg = createRegistry();

    expect(reg.verify('nobody', 'A8B2', 'token-1', 0)).toBe('unknown');
  });

  it('房间号不匹配时校验结果为 invalid（防跨房抢座）', () => {
    const reg = createRegistry();
    const token = reg.issue('p1', 'A8B2', '房主', 'host', 0);

    expect(reg.verify('p1', 'ZZZZ', token, 0)).toBe('invalid');
  });

  it('token 不匹配时校验结果为 invalid', () => {
    const reg = createRegistry();
    reg.issue('p1', 'A8B2', '房主', 'host', 0);

    expect(reg.verify('p1', 'A8B2', 'wrong', 0)).toBe('invalid');
  });
});

describe('grace · 宽限期', () => {
  it('markOffline 后 verify 通过，60s 后 sweep 返回过期项', () => {
    const reg = createRegistry();
    const token = reg.issue('p1', 'A8B2', '房主', 'host', 0);

    const seat = reg.markOffline('p1', 1000);

    expect(seat).not.toBeNull();
    expect(seat?.offlineSinceMs).toBe(1000);
    expect(seat?.expiresAtMs).toBe(1000 + GRACE_MS);
    expect(reg.verify('p1', 'A8B2', token, 30000)).toBe('ok');

    expect(reg.sweep(1000 + GRACE_MS - 1)).toEqual([]);
    const expired = reg.sweep(1000 + GRACE_MS);
    expect(expired.map((s) => s.peerId)).toEqual(['p1']);
    expect(reg.size).toBe(0);
  });

  it('宽限到期后 verify 返回 expired（座位还在但已过期）', () => {
    const reg = createRegistry();
    const token = reg.issue('p1', 'A8B2', '房主', 'host', 0);
    reg.markOffline('p1', 0);

    expect(reg.verify('p1', 'A8B2', token, GRACE_MS + 1)).toBe('expired');
  });

  it('重复 markOffline 只产生一次宽限（幂等，不重复广播）', () => {
    const reg = createRegistry();
    reg.issue('p1', 'A8B2', '房主', 'host', 0);

    const first = reg.markOffline('p1', 1000);
    const second = reg.markOffline('p1', 2000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(reg.sweep(1000 + GRACE_MS)).toHaveLength(1);
  });

  it('markOffline 对未登记的 peerId 返回 null（不在任何房间）', () => {
    const reg = createRegistry();

    expect(reg.markOffline('nobody', 0)).toBeNull();
  });
});

describe('grace · token 轮换（防重放）', () => {
  it('token 轮换后旧 token 校验失败（防重放）', () => {
    const reg = createRegistry();
    const oldToken = reg.issue('p1', 'A8B2', '房主', 'host', 0);
    reg.markOffline('p1', 1000);

    const newToken = reg.rotate('p1', 2000);

    expect(newToken).toBe('token-2');
    expect(reg.verify('p1', 'A8B2', oldToken, 3000)).toBe('invalid');
    expect(reg.verify('p1', 'A8B2', newToken ?? '', 3000)).toBe('ok');
  });

  it('rotate 后座位回到在线态（不再被 sweep 回收）', () => {
    const reg = createRegistry();
    reg.issue('p1', 'A8B2', '房主', 'host', 0);
    reg.markOffline('p1', 0);

    reg.rotate('p1', 1000);

    expect(reg.sweep(GRACE_MS * 10)).toEqual([]);
    expect(reg.size).toBe(1);
  });

  it('rotate 对未登记的 peerId 返回 null', () => {
    const reg = createRegistry();

    expect(reg.rotate('nobody', 0)).toBeNull();
  });
});

describe('grace · 释放', () => {
  it('release 后座位消失，verify 返回 unknown', () => {
    const reg = createRegistry();
    const token = reg.issue('p1', 'A8B2', '房主', 'host', 0);

    reg.release('p1');

    expect(reg.size).toBe(0);
    expect(reg.verify('p1', 'A8B2', token, 0)).toBe('unknown');
  });

  it('release 不存在的座位是空操作', () => {
    const reg = createRegistry();

    expect(() => reg.release('nobody')).not.toThrow();
    expect(reg.size).toBe(0);
  });
});
