/**
 * ============================================================================
 * 座位保持与宽限期簿记（SeatRegistry）
 * ============================================================================
 * 职责边界（SRP）：
 * - `rooms.ts` 回答「谁在哪个房间」；
 * - `grace.ts` 回答「谁在什么时候可以回来、凭什么回来」。
 *
 * 核心机制：**socket 断开时根本不调用 `rooms.leave()`** —— 房间与座位原样保留，
 * 所以「座位保持」的实现成本≈0（ADR-7）。只有宽限期**超时后**才真正 leave。
 *
 * 本文件零 IO：所有时间由调用方以 `nowMs` 传入（便于注入 clock、单测不 sleep）。
 */

import { createToken, tokenEquals } from './token';

/** 一个座位（= 一名玩家的会话身份） */
export interface Seat {
  /** 主键（服务端分配的 peerId） */
  peerId: string;
  /** 4 位房间号（冗余存储，避免反查） */
  room: string;
  /** 昵称（已截断） */
  name: string;
  /** 角色：房主恒为 offerer */
  role: 'host' | 'guest';
  /** 当前有效凭证 */
  token: string;
  /** 进入宽限的时刻；null 表示在线 */
  offlineSinceMs: number | null;
  /** 宽限到期时刻；null 表示在线 */
  expiresAtMs: number | null;
}

/** resume 校验结果 */
export type VerifyResult = 'ok' | 'invalid' | 'expired' | 'unknown';

/** SeatRegistry 构造参数 */
export interface SeatRegistryOptions {
  /** 宽限期毫秒数（默认 60000） */
  graceMs: number;
  /** 凭证生成器（单测注入确定性实现） */
  newToken?: () => string;
}

/**
 * 座位簿记器
 */
export class SeatRegistry {
  private readonly seats = new Map<string, Seat>();
  private readonly graceMs: number;
  private readonly newToken: () => string;

  constructor(opts: SeatRegistryOptions) {
    this.graceMs = Math.max(0, Math.floor(opts.graceMs));
    this.newToken = opts.newToken ?? (() => createToken());
  }

  /** 当前座位数（在线 + 宽限中） */
  get size(): number {
    return this.seats.size;
  }

  /**
   * 登记座位并下发凭证（create / join 成功后调用）。
   *
   * 同一 peerId 重复登记会覆盖旧座位（例如换房）。
   */
  issue(peerId: string, room: string, name: string, role: 'host' | 'guest', _nowMs: number): string {
    const token = this.newToken();
    this.seats.set(peerId, {
      peerId,
      room,
      name,
      role,
      token,
      offlineSinceMs: null,
      expiresAtMs: null,
    });
    return token;
  }

  /**
   * 标记座位进入宽限（socket 断开时调用）。
   *
   * **幂等**：已在宽限中的座位返回 `null`，调用方据此决定「不重复广播 peer-offline」。
   *
   * @returns 首次进入宽限时返回座位快照；未登记或已在宽限中返回 null
   */
  markOffline(peerId: string, nowMs: number): Seat | null {
    const seat = this.seats.get(peerId);
    if (!seat) return null;
    if (seat.offlineSinceMs !== null) return null;

    seat.offlineSinceMs = nowMs;
    seat.expiresAtMs = nowMs + this.graceMs;
    return { ...seat };
  }

  /**
   * 校验 resume 请求。
   *
   * 顺序（不可换）：座位存在? → 房间匹配? → token 匹配? → 未过期?
   */
  verify(peerId: string, room: string, token: string, nowMs: number): VerifyResult {
    const seat = this.seats.get(peerId);
    if (!seat) return 'unknown';
    if (seat.room !== room) return 'invalid';
    if (!tokenEquals(seat.token, token)) return 'invalid';
    if (seat.offlineSinceMs !== null && seat.expiresAtMs !== null && nowMs >= seat.expiresAtMs) {
      return 'expired';
    }
    return 'ok';
  }

  /**
   * 轮换凭证并让座位回到在线态（resume 成功后调用）。
   *
   * 旧 token 立即失效 → 防重放、防同 token 双连接抢座。
   *
   * @returns 新凭证；座位不存在返回 null
   */
  rotate(peerId: string, _nowMs: number): string | null {
    const seat = this.seats.get(peerId);
    if (!seat) return null;
    const token = this.newToken();
    seat.token = token;
    seat.offlineSinceMs = null;
    seat.expiresAtMs = null;
    return token;
  }

  /** 立即释放座位（主动 leave / 宽限超时） */
  release(peerId: string): void {
    this.seats.delete(peerId);
  }

  /**
   * 回收已过期的座位。
   *
   * @returns 过期座位列表（调用方负责 `rooms.leave()` → 广播 `peer-left`）
   */
  sweep(nowMs: number): Seat[] {
    const expired: Seat[] = [];
    for (const [peerId, seat] of this.seats) {
      if (seat.offlineSinceMs === null || seat.expiresAtMs === null) continue;
      if (nowMs < seat.expiresAtMs) continue;
      expired.push({ ...seat });
      this.seats.delete(peerId);
    }
    return expired;
  }

  /** 只读查询座位（诊断用，不参与校验） */
  peek(peerId: string): Seat | null {
    const seat = this.seats.get(peerId);
    return seat ? { ...seat } : null;
  }
}
