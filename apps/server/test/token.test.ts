import { describe, expect, it } from 'vitest';

import { createToken, tokenEquals } from '../src/token';

describe('token · 座位凭证生成', () => {
  it('createToken 注入固定 rand 时输出确定且长度 ≥32', () => {
    const rand = (n: number) => new Uint8Array(n).fill(7);

    const a = createToken(rand);
    const b = createToken(rand);

    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    // base64url 字符集：A-Z a-z 0-9 - _
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });

  it('默认随机源下两次生成不同（不可预测）', () => {
    expect(createToken()).not.toBe(createToken());
  });

  it('bytes 参数决定熵长度，且不短于 24 字节（≥32 字符）', () => {
    expect(createToken(undefined, 24).length).toBe(32);
    expect(createToken(undefined, 32).length).toBe(43);
  });

  it('bytes 低于安全下限时被钳制到 24 字节', () => {
    expect(createToken(undefined, 4).length).toBe(32);
  });
});

describe('token · 常量时间比较', () => {
  it('相同 token 比较为真', () => {
    expect(tokenEquals('abcDEF123', 'abcDEF123')).toBe(true);
  });

  it('不同 token 比较为假', () => {
    expect(tokenEquals('abcDEF123', 'abcDEF124')).toBe(false);
  });

  it('长度不同时比较为假（不抛异常）', () => {
    expect(tokenEquals('abc', 'abcdef')).toBe(false);
    expect(tokenEquals('', 'abcdef')).toBe(false);
  });
});
