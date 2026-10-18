/**
 * ============================================================================
 * ConnectionStatus 投影（快照 → 业务可见的唯一状态源）
 * ============================================================================
 * `isPlayable` 是全仓唯一的业务判据，只在 `deriveStatus()` 里由
 * `state === 'CONNECTED'` 单点计算，禁止任何其他地方二次赋值。
 *
 * D4「对手宽限期内锁落子」**不进** `isPlayable`：它由 UI 层与
 * `peerOfflineInMs` 合成，保证 `isPlayable` 的语义稳定（我这条链路能不能用）。
 */

import { RETRY_RULES } from './classify';
import type { FailReason } from './classify';
import type { ReconnectPolicy } from './policy';
import type { ConnSnapshot, ConnState } from './state';

/** 业务层唯一可见的连接状态 */
export interface ConnectionStatus {
  /** 8 状态之一 */
  state: ConnState;
  /** 唯一业务判据：只有 CONNECTED 为 true */
  isPlayable: boolean;
  /** 已消耗的重试次数 */
  attempt: number;
  /** 最大重试次数 */
  maxAttempts: number;
  /** UI 倒计时（仅 RECONNECTING 有值） */
  nextRetryInMs: number | null;
  /** 最近失败原因 */
  reason: FailReason | null;
  /** 状态条主文案（PRD §6.4 逐字） */
  label: string;
  /** 是否可立即重试 */
  canRetryNow: boolean;
  /** 是否可离开房间 */
  canLeave: boolean;
  /** 本端角色 */
  role: 'host' | 'guest' | null;
  /** 当前房间号 */
  room: string | null;
  /** 对手宽限倒计时（D4） */
  peerOfflineInMs: number | null;
  /** 服务端协议版本 */
  compat: 'v1' | 'v1.1';
}

/** 剩余秒数（向上取整，不为负） */
function remainingSecs(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

/** 生成状态条主文案（PRD §6.4） */
function labelOf(s: ConnSnapshot, p: ReconnectPolicy, nowMs: number): string {
  switch (s.state) {
    case 'IDLE':
      return '未连接';
    case 'SIGNAL_CONNECTING':
      return s.attempt > 0 ? `正在重连（第 ${s.attempt}/${p.maxAttempts} 次）…` : '正在连接服务器…';
    case 'ROOM_WAITING':
      return s.room ? `房间 ${s.room} · 等待对手加入…` : '等待对手加入…';
    case 'NEGOTIATING':
      return '对手已加入，正在建立直连…';
    case 'CONNECTED':
      return s.peerOfflineUntilMs === null
        ? '已直连'
        : `对手网络不稳定，正在重连…（剩余 ${remainingSecs(s.peerOfflineUntilMs, nowMs)}s）`;
    case 'P2P_RECOVERING':
      return '网络波动，正在恢复直连…（自动）';
    case 'RECONNECTING': {
      const rest =
        s.nextRetryAtMs === null ? 0 : remainingSecs(s.nextRetryAtMs, nowMs);
      const attempt = Math.max(1, s.attempt);
      return `连接中断，正在重连（第 ${attempt}/${p.maxAttempts} 次）… 剩余 ${rest}s`;
    }
    case 'FAILED': {
      const reasonLabel = s.reason ? RETRY_RULES[s.reason].label : '连接失败';
      return `已断开：${reasonLabel}。棋盘已保留。`;
    }
    default:
      return '未连接';
  }
}

/**
 * 把快照投影成业务状态。
 *
 * @param s 状态机快照
 * @param p 策略参数（取 maxAttempts）
 * @param nowMs 当前时刻（用于倒计时，由调用方注入）
 */
export function deriveStatus(s: ConnSnapshot, p: ReconnectPolicy, nowMs: number): ConnectionStatus {
  return {
    state: s.state,
    isPlayable: s.state === 'CONNECTED',
    attempt: s.attempt,
    maxAttempts: p.maxAttempts,
    nextRetryInMs: s.nextRetryAtMs === null ? null : Math.max(0, s.nextRetryAtMs - nowMs),
    reason: s.reason,
    label: labelOf(s, p, nowMs),
    canRetryNow:
      s.state === 'FAILED' || (s.state === 'RECONNECTING' && !s.paused),
    canLeave: s.state !== 'IDLE',
    role: s.role,
    room: s.room,
    peerOfflineInMs:
      s.peerOfflineUntilMs === null ? null : Math.max(0, s.peerOfflineUntilMs - nowMs),
    compat: s.serverCompat,
  };
}
