/**
 * ============================================================================
 * 应用层心跳判定（吃时间戳，不创建定时器）
 * ============================================================================
 * WS 与 DC 共用本模块的同一份语义，各自持有独立实例。
 *
 * 最坏判定时延推导（**改参数前请先读这段，否则 M4 会悄悄失效**）：
 *   pong@t0 → 下一次探测 t0+interval(5s) → 第一次超时 t0+8s → 再发 →
 *   第二次超时 t0+11s → misses=2 → dead。
 *   加上一次 tick 抖动，实际 ≤16s（PRD M4 要求半开连接 ≤16s 内被发现）。
 *
 * 单飞约束：`pendingSinceMs !== null` 时不许再发第二次探测
 * （PRD §7「同一时刻最多 1 个在途探测」）。
 */

import type { WsHeartbeatConfig } from './policy';

/** 心跳状态快照（不可变） */
export interface HeartbeatState {
  /** 在途探测的发出时刻；null 表示当前没有在途探测 */
  readonly pendingSinceMs: number | null;
  /** 连续超时次数 */
  readonly misses: number;
  /** 最近一次收到 pong 的时刻 */
  readonly lastPongAtMs: number | null;
}

/** 心跳判定结果 */
export type HeartbeatVerdict = 'idle' | 'due' | 'waiting' | 'miss' | 'dead';

/** 创建初始心跳状态 */
export function createHeartbeat(_nowMs: number): HeartbeatState {
  return { pendingSinceMs: null, misses: 0, lastPongAtMs: null };
}

/** 记录一次探测已发出 */
export function markSent(s: HeartbeatState, nowMs: number): HeartbeatState {
  return { ...s, pendingSinceMs: nowMs };
}

/** 记录收到 pong：清零 miss、记下时刻、清空在途标记 */
export function markPong(_s: HeartbeatState, nowMs: number): HeartbeatState {
  return { pendingSinceMs: null, misses: 0, lastPongAtMs: nowMs };
}

/**
 * 纯判定：给定状态与当前时刻，返回下一步该做什么。
 *
 * - `waiting`：有在途探测且未超时 → 什么都不做
 * - `miss`：本次探测超时，但还没到判死阈值
 * - `dead`：连续超时达 `cfg.misses` → 连接已死
 * - `due`：应当发一次新探测
 * - `idle`：还没到下次探测时间
 */
export function evaluate(
  s: HeartbeatState,
  nowMs: number,
  cfg: WsHeartbeatConfig
): { verdict: HeartbeatVerdict; state: HeartbeatState } {
  if (s.pendingSinceMs !== null) {
    if (nowMs - s.pendingSinceMs >= cfg.timeoutMs) {
      const misses = s.misses + 1;
      const next: HeartbeatState = { ...s, pendingSinceMs: null, misses };
      return { verdict: misses >= cfg.misses ? 'dead' : 'miss', state: next };
    }
    return { verdict: 'waiting', state: s };
  }

  // 从未收到过 pong（首次探测）或距上次 pong 已过一个间隔 → 该发探测了
  if (s.lastPongAtMs === null) {
    return { verdict: 'due', state: s };
  }
  if (nowMs - s.lastPongAtMs >= cfg.intervalMs) {
    return { verdict: 'due', state: s };
  }
  return { verdict: 'idle', state: s };
}
