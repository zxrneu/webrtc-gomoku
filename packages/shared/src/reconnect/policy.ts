/**
 * ============================================================================
 * 重连策略参数与退避纯函数（零 IO / 零时钟）
 * ============================================================================
 * 「退避等多久」是重连体验的核心参数，必须可被单测精确锁定：
 * - 时钟与随机数全部由调用方注入（`random` 返回 [0,1)）；
 * - 本文件不读取 `Date.now()`，不创建定时器。
 */

/** WS 应用层心跳参数（DC 心跳复用同一份结构，是两个独立实例） */
export interface WsHeartbeatConfig {
  /** 两次探测之间的最小间隔 */
  intervalMs: number;
  /** 单次探测等待 pong 的超时 */
  timeoutMs: number;
  /** 连续多少次超时判定「连接已死」 */
  misses: number;
}

/** P2P 恢复相关参数 */
export interface P2pConfig {
  /** 首次协商的最长等待时间（含加入方等待 offer） */
  negotiationTimeoutMs: number;
  /** `pc.connectionState==='disconnected'` 需持续多久才判定真的断了（去抖） */
  disconnectedGraceMs: number;
  /** DC 应用层心跳参数 */
  dcHeartbeat: WsHeartbeatConfig;
  /** ICE restart 尝试次数 */
  iceRestartAttempts: number;
  /** 第 N 次 ICE restart 前的额外等待（毫秒），下标从 0 开始 */
  iceRestartDelaysMs: readonly number[];
  /** 全量重建次数 */
  rebuildAttempts: number;
  /** 等对手 peer-online 的最长时间，超时降级为全量重建 */
  peerOnlineWaitMs: number;
}

/** 重连策略总参数表 */
export interface ReconnectPolicy {
  /** 退避基数 500ms */
  baseDelayMs: number;
  /** 退避上限 16000ms */
  capDelayMs: number;
  /** 最大重试次数 6 */
  maxAttempts: number;
  /** 抖动比例 0.2（±20%） */
  jitterRatio: number;
  /** 单次连接超时 5000ms */
  connectTimeoutMs: number;
  /** 同一 incident 内的防抖窗口 1000ms */
  debounceMs: number;
  /** 回到 CONNECTED 后稳定多久才算 incident 关闭 */
  incidentSettleMs: number;
  /** WS 心跳参数 */
  wsHeartbeat: WsHeartbeatConfig;
  /** P2P 恢复参数 */
  p2p: P2pConfig;
  /** 服务端宽限期（秒）——仅用于 UI 兜底倒计时，权威值以 peer-offline.graceSec 为准 */
  serverGraceSecs: number;
  /** 恢复后是否强制对账 */
  syncOnRestore: boolean;
}

/**
 * 默认策略（唯一真源，禁止其他文件再写字面量）
 */
export const DEFAULT_POLICY: ReconnectPolicy = {
  baseDelayMs: 500,
  capDelayMs: 16000,
  maxAttempts: 6,
  jitterRatio: 0.2,
  connectTimeoutMs: 5000,
  debounceMs: 1000,
  incidentSettleMs: 10000,
  wsHeartbeat: { intervalMs: 5000, timeoutMs: 3000, misses: 2 },
  p2p: {
    negotiationTimeoutMs: 15000,
    disconnectedGraceMs: 5000,
    dcHeartbeat: { intervalMs: 5000, timeoutMs: 3000, misses: 2 },
    iceRestartAttempts: 2,
    iceRestartDelaysMs: [0, 3000],
    rebuildAttempts: 1,
    peerOnlineWaitMs: 3000,
  },
  serverGraceSecs: 60,
  syncOnRestore: true,
};

/** 把任意数值钳制到 [0,1]（random() 契约被破坏时不产生异常退避） */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 计算第 `attempt` 次重试的退避时长。
 *
 * `delay = min(base * 2^(attempt-1), cap) * (1 + jitterRatio * (2r-1))`，
 * 结果再被 `capDelayMs` 截断，保证任何抖动下都不会突破上限。
 *
 * @param attempt 第几次重试（从 1 开始；<=0 按 1 处理）
 * @param p 策略参数
 * @param random 随机源，返回 [0,1)
 * @returns 毫秒数（已取整）
 */
export function nextDelayMs(attempt: number, p: ReconnectPolicy, random: () => number): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(p.baseDelayMs * 2 ** (n - 1), p.capDelayMs);
  const r = clamp01(random());
  const jitter = 1 + p.jitterRatio * (r * 2 - 1);
  return Math.min(p.capDelayMs, Math.round(base * jitter));
}

/**
 * 用户可感知的「自动重连总窗口」。
 *
 * = Σ nextDelayMs(1..maxAttempts, random=0.5) + (maxAttempts-1) × connectTimeoutMs
 * = 31500 + 25000 = 56500ms（最后一次退避后不再等一次连接超时）
 *
 * 与 PRD R3「≈45s」的口径差异已在 architecture.md §2.2 记录：45s 是约数，
 * 以本函数实测值为准并由单测锁定。
 */
export function totalWindowMs(p: ReconnectPolicy): number {
  let sum = 0;
  for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
    sum += nextDelayMs(attempt, p, () => 0.5);
  }
  return sum + Math.max(0, p.maxAttempts - 1) * p.connectTimeoutMs;
}
