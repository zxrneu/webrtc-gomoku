/**
 * ============================================================================
 * 连接状态机（8 状态 reducer，纯函数）
 * ============================================================================
 * 设计要点（见 architecture.md §2.3 / §3）：
 * 1. 迁移用「事件 × 允许的来源状态」表驱动，未命中即**拒绝**；
 * 2. 非法迁移**返回同一个快照引用**（不抛异常、不打日志），
 *    让单测能 `toBe` 精确断言，也让编排器据此判断「是否真的迁移了」；
 * 3. `attempt` 只在 `SIGNAL_LOST` 时 +1，且同一 incident 内 `debounceMs` 内的重复
 *    断开整体拒绝（R2 防抖）；
 * 4. `paused` 是**修饰符**而非状态（ADR-4），可作用于任意状态。
 */

import type { FailReason } from './classify';
import type { ReconnectPolicy } from './policy';

/** 8 个状态字面量（K1，一字不差，唯一声明处） */
export const CONN_STATES = [
  'IDLE',
  'SIGNAL_CONNECTING',
  'ROOM_WAITING',
  'NEGOTIATING',
  'CONNECTED',
  'P2P_RECOVERING',
  'RECONNECTING',
  'FAILED',
] as const;

/** 连接状态 */
export type ConnState = (typeof CONN_STATES)[number];

/** 状态机快照（不可变；刻意不放 moves，见 §2.3 结构决策） */
export interface ConnSnapshot {
  readonly state: ConnState;
  /** 已消耗的 WS 重试次数 0..maxAttempts */
  readonly attempt: number;
  /** 已消耗的 P2P 恢复次数 0..(iceRestartAttempts + rebuildAttempts) */
  readonly p2pAttempt: number;
  /** RECONNECTING 才有值 → UI 倒计时 */
  readonly nextRetryAtMs: number | null;
  /** 最近一次失败原因 */
  readonly reason: FailReason | null;
  /** 进入当前状态的时刻 */
  readonly since: number;
  /** 页面隐藏修饰符（不是状态） */
  readonly paused: boolean;
  /** 本端角色 */
  readonly role: 'host' | 'guest' | null;
  /** 当前房间号 */
  readonly room: string | null;
  /** D4：对手宽限到期时刻 */
  readonly peerOfflineUntilMs: number | null;
  /** 最近一次真实失败时刻（用于 debounce） */
  readonly lastFailAtMs: number;
  /** 最近一次对账补手数 */
  readonly movesSynced: number;
  /** 服务端协议版本（旧服务端降级后为 'v1'） */
  readonly serverCompat: 'v1' | 'v1.1';
}

/** 创建初始快照 */
export function initialSnapshot(nowMs: number): ConnSnapshot {
  return {
    state: 'IDLE',
    attempt: 0,
    p2pAttempt: 0,
    nextRetryAtMs: null,
    reason: null,
    since: nowMs,
    paused: false,
    role: null,
    room: null,
    peerOfflineUntilMs: null,
    lastFailAtMs: 0,
    movesSynced: 0,
    serverCompat: 'v1.1',
  };
}

/** 状态机事件（`type` 用 SCREAMING_SNAKE，与 IO 事件的 kebab-case 区分，见 K7） */
export type ConnEvent =
  | { type: 'START'; at: number; role: 'host' | 'guest'; room: string | null }
  | { type: 'SIGNAL_LOST'; at: number; reason: FailReason }
  | { type: 'SIGNAL_OPEN'; at: number }
  | { type: 'ROOM_READY'; at: number; room: string }
  | { type: 'PEER_PRESENT'; at: number }
  | { type: 'PEER_OFFLINE'; at: number; graceSecs: number }
  | { type: 'DC_OPEN'; at: number }
  | { type: 'P2P_LOST'; at: number; reason: FailReason }
  | { type: 'RETRY_DUE'; at: number }
  | { type: 'RETRY_NOW'; at: number }
  | { type: 'P2P_EXHAUSTED'; at: number }
  | { type: 'FATAL'; at: number; reason: FailReason }
  | { type: 'PAUSE'; at: number }
  | { type: 'RESUME'; at: number }
  | { type: 'INCIDENT_CLOSED'; at: number }
  | { type: 'SYNCED'; at: number; movesSynced: number }
  | { type: 'SERVER_COMPAT'; at: number; compat: 'v1' | 'v1.1' }
  | { type: 'PEER_GONE'; at: number }
  | { type: 'LEAVE'; at: number };

/** 穷尽性兜底：新增 ConnEvent 类型而忘记加分支时编译期报错 */
function assertNever(value: never): never {
  throw new Error(`未处理的状态机事件: ${JSON.stringify(value)}`);
}

/** 已处于可迁移状态集合中的某个 */
function isOneOf(state: ConnState, allowed: readonly ConnState[]): boolean {
  return allowed.includes(state);
}

/** 可被「信令断开」打断的状态 */
const SIGNAL_LOST_FROM: readonly ConnState[] = [
  'SIGNAL_CONNECTING',
  'ROOM_WAITING',
  'NEGOTIATING',
  'CONNECTED',
  'P2P_RECOVERING',
  'RECONNECTING',
];

/** 可进入 FAILED 的状态 */
const FATAL_FROM: readonly ConnState[] = ['SIGNAL_CONNECTING', 'RECONNECTING', 'P2P_RECOVERING'];

/** 可被「对手离开」清盘的状态 */
const PEER_GONE_FROM: readonly ConnState[] = [
  'ROOM_WAITING',
  'NEGOTIATING',
  'CONNECTED',
  'P2P_RECOVERING',
  'RECONNECTING',
];

/** 清空一次 incident 的全部计数 */
const CLEAN: Pick<ConnSnapshot, 'attempt' | 'p2pAttempt' | 'reason' | 'nextRetryAtMs'> = {
  attempt: 0,
  p2pAttempt: 0,
  reason: null,
  nextRetryAtMs: null,
};

/**
 * 状态机 reducer（纯函数）。
 *
 * @param s 当前快照
 * @param e 事件
 * @param p 策略参数（用到 maxAttempts / debounceMs / p2p 恢复次数）
 * @returns 新快照；**非法迁移原样返回 `s` 同一引用**
 */
export function reduce(s: ConnSnapshot, e: ConnEvent, p: ReconnectPolicy): ConnSnapshot {
  switch (e.type) {
    case 'START':
      if (s.state !== 'IDLE') return s;
      return {
        ...s,
        ...CLEAN,
        state: 'SIGNAL_CONNECTING',
        role: e.role,
        room: e.room,
        peerOfflineUntilMs: null,
        movesSynced: 0,
        since: e.at,
      };

    case 'SIGNAL_OPEN':
      // socket 打开本身不迁移状态：只用于触发 resume / join
      return s;

    case 'ROOM_READY':
      if (s.state !== 'SIGNAL_CONNECTING') return s;
      return { ...s, state: 'ROOM_WAITING', room: e.room, since: e.at };

    case 'PEER_PRESENT':
      if (s.state !== 'ROOM_WAITING') return s;
      return { ...s, state: 'NEGOTIATING', since: e.at };

    case 'PEER_OFFLINE':
      if (!isOneOf(s.state, ['CONNECTED', 'P2P_RECOVERING'])) return s;
      // 只写宽限到期时刻，不改变状态（D4 的锁落子由 UI 层与 peerOfflineInMs 合成）
      return { ...s, peerOfflineUntilMs: e.at + e.graceSecs * 1000 };

    case 'DC_OPEN':
      if (s.state === 'NEGOTIATING') {
        return { ...s, state: 'CONNECTED', reason: null, peerOfflineUntilMs: null, since: e.at };
      }
      // P2P_RECOVERING 下必须等 SYNCED 才能回到 CONNECTED
      return s;

    case 'SIGNAL_LOST': {
      if (!isOneOf(s.state, SIGNAL_LOST_FROM)) return s;
      // R2 防抖：同一 incident 内 1s 多次 close 只计 1 次 attempt
      if (s.state === 'RECONNECTING' && s.attempt > 0 && e.at - s.lastFailAtMs < p.debounceMs) {
        return s;
      }
      const attempt = s.attempt + 1;
      return {
        ...s,
        state: 'RECONNECTING',
        attempt,
        reason: e.reason,
        nextRetryAtMs: null,
        peerOfflineUntilMs: null,
        lastFailAtMs: e.at,
        since: s.state === 'RECONNECTING' ? s.since : e.at,
      };
    }

    case 'P2P_LOST': {
      if (!isOneOf(s.state, ['NEGOTIATING', 'CONNECTED', 'P2P_RECOVERING'])) return s;
      const p2pAttempt = s.p2pAttempt + 1;
      return {
        ...s,
        state: 'P2P_RECOVERING',
        p2pAttempt,
        reason: e.reason,
        since: s.state === 'P2P_RECOVERING' ? s.since : e.at,
      };
    }

    case 'SYNCED':
      if (s.state !== 'P2P_RECOVERING') return s;
      return {
        ...s,
        state: 'CONNECTED',
        movesSynced: e.movesSynced,
        reason: null,
        p2pAttempt: 0,
        peerOfflineUntilMs: null,
        since: e.at,
      };

    case 'P2P_EXHAUSTED':
      if (s.state !== 'P2P_RECOVERING') return s;
      return { ...s, state: 'FAILED', reason: 'ICE_FAILED', nextRetryAtMs: null, since: e.at };

    case 'RETRY_DUE':
      if (s.state !== 'RECONNECTING') return s;
      // 页面隐藏时拒绝（编排器负责在 RESUME 时立即重试，避免永久卡住）
      if (s.paused) return s;
      return { ...s, state: 'SIGNAL_CONNECTING', nextRetryAtMs: null, since: e.at };

    case 'RETRY_NOW':
      if (s.state === 'RECONNECTING') {
        return { ...s, state: 'SIGNAL_CONNECTING', nextRetryAtMs: null, since: e.at };
      }
      if (s.state === 'FAILED') {
        // PRD R12：FAILED 下手动重连必须重置 attempt
        return { ...s, ...CLEAN, state: 'SIGNAL_CONNECTING', since: e.at };
      }
      return s;

    case 'FATAL':
      if (!isOneOf(s.state, FATAL_FROM)) return s;
      return { ...s, state: 'FAILED', reason: e.reason, nextRetryAtMs: null, since: e.at };

    case 'PAUSE':
      if (s.paused) return s;
      return { ...s, paused: true };

    case 'RESUME':
      if (!s.paused) return s;
      return { ...s, paused: false };

    case 'INCIDENT_CLOSED':
      if (s.state !== 'CONNECTED') return s;
      return { ...s, ...CLEAN, lastFailAtMs: 0 };

    case 'SERVER_COMPAT':
      if (s.serverCompat === e.compat) return s;
      return { ...s, serverCompat: e.compat };

    case 'PEER_GONE':
      if (!isOneOf(s.state, PEER_GONE_FROM)) return s;
      return {
        ...s,
        ...CLEAN,
        state: 'IDLE',
        peerOfflineUntilMs: null,
        movesSynced: 0,
        since: e.at,
      };

    case 'LEAVE':
      if (s.state === 'IDLE') return s;
      return {
        ...s,
        ...CLEAN,
        state: 'IDLE',
        role: null,
        room: null,
        peerOfflineUntilMs: null,
        movesSynced: 0,
        since: e.at,
      };

    default:
      return assertNever(e);
  }
}
