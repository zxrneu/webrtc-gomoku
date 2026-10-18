/**
 * ============================================================================
 * 失败原因分类与「是否值得重试」判定表（纯映射，零 IO）
 * ============================================================================
 * 设计要点：
 * 1. `RETRY_RULES` 是 `Record<FailReason, RetryRule>` —— 新增 FailReason 时编译期报错；
 * 2. 未知错误码一律兜底为 `SERVER_REJECTED`（终态 + 原文），永不无限重试；
 * 3. 文案逐字复用服务端 v1 的既有文案（`apps/server/src/rooms.ts`），一个标点都不改。
 */

/** 全部失败原因（K2，逐字） */
export const FAIL_REASONS = [
  'NETWORK_OFFLINE',
  'WS_CLOSED',
  'WS_TIMEOUT',
  'SERVER_REJECTED',
  'SERVER_RESTART',
  'ICE_FAILED',
  'DC_NOT_OPEN',
  'POLICY_EXHAUSTED',
  'USER_CANCELLED',
] as const;

/** 失败原因字面量联合 */
export type FailReason = (typeof FAIL_REASONS)[number];

/** 单个失败原因的重试规则 */
export interface RetryRule {
  /** 是否消耗 WS 重试次数（attempt） */
  countsAttempt: boolean;
  /** 是否允许自动重试 */
  autoRetry: boolean;
  /** FAILED 态展示的原因文案（PRD §6.4 逐字） */
  label: string;
}

/**
 * 重试规则表（唯一真源，UI / 编排器 / 日志全部读它）
 */
export const RETRY_RULES: Readonly<Record<FailReason, RetryRule>> = {
  NETWORK_OFFLINE: { countsAttempt: true, autoRetry: true, label: '网络不可用' },
  WS_CLOSED: { countsAttempt: true, autoRetry: true, label: '连接被关闭' },
  WS_TIMEOUT: { countsAttempt: true, autoRetry: true, label: '服务器无响应' },
  // 文案由服务端原文承载（见 ConnSideEffect.failed.message），此处仅作兜底
  SERVER_REJECTED: { countsAttempt: false, autoRetry: false, label: '服务端拒绝了本次请求' },
  SERVER_RESTART: { countsAttempt: true, autoRetry: true, label: '服务器已重启，房间失效' },
  ICE_FAILED: { countsAttempt: false, autoRetry: true, label: '直连建立失败（可能处于对称 NAT）' },
  DC_NOT_OPEN: { countsAttempt: false, autoRetry: false, label: '直连通道未就绪，本手未送达' },
  POLICY_EXHAUSTED: { countsAttempt: false, autoRetry: false, label: '多次重试失败' },
  USER_CANCELLED: { countsAttempt: false, autoRetry: false, label: '' },
};

/** 失败来源（用于把「哪一层出的问题」翻译成 FailReason） */
export type FailSource =
  | 'ws-close'
  | 'ws-error'
  | 'ws-heartbeat'
  | 'connect-timeout'
  | 'pc-state'
  | 'dc-heartbeat'
  | 'dc-send'
  | 'ice-restart'
  | 'server-error'
  | 'resume-rejected'
  | 'attempts-exhausted'
  | 'user-leave';

/** 分类器输入 */
export interface ClassifyInput {
  /** 失败来自哪一层 */
  source: FailSource;
  /** navigator.onLine */
  online?: boolean;
  /** WebSocket 关闭码（1000/1001/1006） */
  closeCode?: number;
  /** 服务端 {t:'error'}.message */
  serverMessage?: string;
  /** 服务端 {t:'error'}.code（v1.1 才有，旧服务端缺失） */
  serverCode?: string;
  /** 已消耗的重试次数 */
  attempts?: number;
  /** 最大重试次数 */
  maxAttempts?: number;
}

/** 旧服务端「未知消息类型」文案（与 `server.ts:146-147` 逐字一致） */
const UNSUPPORTED_MESSAGE = '未知消息类型';

/**
 * 把一次失败翻译成 FailReason。
 *
 * 判定顺序：先看来源，再看 `online`，最后看服务端 `code`/文案。
 */
export function classifyFailure(input: ClassifyInput): FailReason {
  switch (input.source) {
    case 'ws-close':
    case 'ws-error':
      return input.online === false ? 'NETWORK_OFFLINE' : 'WS_CLOSED';
    case 'connect-timeout':
      return input.online === false ? 'NETWORK_OFFLINE' : 'WS_TIMEOUT';
    case 'ws-heartbeat':
      return 'WS_TIMEOUT';
    case 'pc-state':
    case 'dc-heartbeat':
    case 'ice-restart':
      return 'ICE_FAILED';
    case 'dc-send':
      return 'DC_NOT_OPEN';
    case 'resume-rejected':
      // 座位已释放 / 房间丢失 → 服务端重启口径（可降级为同房号重建）
      return 'SERVER_RESTART';
    case 'attempts-exhausted':
      return 'POLICY_EXHAUSTED';
    case 'user-leave':
      return 'USER_CANCELLED';
    case 'server-error':
      // 房号非法 / 已存在 / 不存在 / 已满 / 未知码 —— 全部终态，永不无限重试
      return 'SERVER_REJECTED';
    default:
      return 'SERVER_REJECTED';
  }
}

/**
 * 是否为「旧服务端不认识该消息」的探测信号。
 *
 * 命中即说明对端是 v1 服务端：必须关闭 L2 心跳、跳过 resume、降级为
 * 「重新 join + 新建 PC」，且只探测一次（K8-2）。
 */
export function isUnsupportedMessageError(message: string): boolean {
  return message.trim() === UNSUPPORTED_MESSAGE;
}

/**
 * 是否为「房间本身不可用」类错误（重试无意义）。
 *
 * 文案逐字来自 `apps/server/src/rooms.ts`：房号格式 / 已存在 / 不存在 / 已满 / 已在房间。
 */
export function isRoomInvalidError(message: string): boolean {
  return /房间号需为|已存在|不存在|已满|已在房间/.test(message);
}
