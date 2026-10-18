/**
 * ============================================================================
 * 日志事件契约与脱敏工具（shared 只声明接口，sink 在 web / server）
 * ============================================================================
 * **脱敏靠类型**：`LogEvent` 的字段集合就是白名单。
 * SDP / ICE candidate / IP / TURN 凭证 / resume token **在类型上无处可放**，
 * 因此「不小心打印了敏感信息」在编译期就不可能发生。
 *
 * 仅有两个把「原始值」转成「可打印值」的函数：`maskRoom` 与 `hostOf`。
 */

import type { FailReason } from './classify';
import type { ConnState } from './state';

/** 客户端日志事件（K3：只允许这 6 个事件与这些字段） */
export type LogEvent =
  | {
      ev: 'conn.state';
      from: ConnState;
      to: ConnState;
      attempt: number;
      reason: FailReason | null;
      sinceMs: number;
    }
  | { ev: 'conn.retry'; attempt: number; delayMs: number; reason: FailReason; urlHost: string }
  | {
      ev: 'conn.restore';
      attempt: number;
      totalMs: number;
      via: 'ice-restart' | 'rebuild' | 'ws-only';
      movesSynced: number;
    }
  | {
      ev: 'conn.fail';
      reason: FailReason;
      attempt: number;
      totalMs: number;
      online: boolean;
      visibility: 'visible' | 'hidden';
    }
  | { ev: 'conn.compat'; server: 'v1' | 'v1.1' }
  | { ev: 'conn.sync-reject'; rev: number; at: number };

/** 日志出口抽象：web 实现为 console，服务端实现为 log() */
export interface Logger {
  log(e: LogEvent): void;
}

/** 空实现（单测 / 服务端复用同一份编排逻辑时使用） */
export const NOOP_LOGGER: Logger = {
  log(): void {
    /* 故意留空：不打印任何内容 */
  },
};

/**
 * 房间号打码：`'A8B2'` → `'A**2'`；非法长度一律 `'****'`。
 */
export function maskRoom(room: string | null): string {
  if (!room || room.length !== 4) return '****';
  return `${room.charAt(0)}**${room.charAt(3)}`;
}

/**
 * 从信令 URL 中提取 host（丢弃协议、端口、path、query、fragment、userinfo）。
 *
 * 不用 `new URL()`：shared 必须零 DOM 依赖，且 URL 解析失败时的兜底行为要可控。
 */
export function hostOf(url: string): string {
  if (!url) return 'unknown';

  // 去掉协议头（若有）
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  const rest = schemeMatch ? url.slice(schemeMatch[0].length) : url;

  // 只取 authority 段（遇到 / ? # 截止）
  let authority = rest;
  for (const sep of ['/', '?', '#']) {
    const idx = authority.indexOf(sep);
    if (idx >= 0) authority = authority.slice(0, idx);
  }
  if (!authority) return 'unknown';

  // 丢弃 userinfo（可能含凭证）
  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  if (!hostPort) return 'unknown';

  // IPv6 字面量：[::1]:3000
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    return end > 0 ? hostPort.slice(0, end + 1) : 'unknown';
  }

  const colon = hostPort.indexOf(':');
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  return host || 'unknown';
}
