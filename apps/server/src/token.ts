/**
 * ============================================================================
 * 座位凭证（resume token）生成与比较
 * ============================================================================
 * 为什么需要凭证：`resume` 只用 `peerId` 就能占回座位的话，任何人只要知道对手的
 * peerId 就能抢座。凭证随 `created`/`joined` 下发，**只走内存**，绝不进 URL / 日志。
 *
 * 安全要点：
 * 1. 随机源默认 `node:crypto`，可注入以便确定性单测（禁止硬编码密钥）；
 * 2. 熵不低于 24 字节（base64url 后 ≥32 字符）；
 * 3. 比较用 `timingSafeEqual`，避免逐字节比较泄漏长度/前缀信息。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 凭证最小熵（字节）。24 字节 → base64url 32 字符 */
const MIN_BYTES = 24;

/** 随机字节源：`n` 为所需字节数。单测注入确定性实现即可复现输出 */
export type Rand = (n: number) => Uint8Array;

/**
 * 默认随机源。
 *
 * 提成模块级常量而不是写在默认参数里：默认参数每次调用都会新建一个闭包，
 * 函数身份不稳定（无法复用 / 无法比较）。`randomBytes(size)` 返回的 `Buffer`
 * 是 `Uint8Array` 子类，签名天然兼容，直接引用即可，不必再包一层。
 */
const defaultRand: Rand = randomBytes;

/**
 * 生成一个座位凭证（base64url）。
 *
 * @param rand 随机字节源，默认 `crypto.randomBytes`（单测注入固定实现）
 * @param bytes 熵长度，低于 24 会被钳制到 24
 * @returns base64url 字符串（不含 `=` 补位）
 */
export function createToken(rand: Rand = defaultRand, bytes = MIN_BYTES): string {
  const size = Math.max(MIN_BYTES, Math.floor(bytes));
  return Buffer.from(rand(size)).toString('base64url');
}

/**
 * 常量时间比较两个凭证。
 *
 * 长度不同时直接返回 false（`timingSafeEqual` 会抛异常，必须先挡住）。
 */
export function tokenEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}
