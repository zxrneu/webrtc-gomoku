/**
 * ============================================================================
 * 客户端日志出口（**本目录内唯一允许出现 `console.*` 的文件**）
 * ============================================================================
 * 设计要点（AGENTS §5 脱敏红线 / architecture.md §8）：
 * 1. `shared` 只声明 `LogEvent` 与 `Logger` 接口，**打印动作**必须落在具体平台；
 * 2. 脱敏靠类型：`LogEvent` 的字段集合就是白名单，SDP / ICE candidate / IP /
 *    TURN 凭证 / resume token 在类型上无处可放，因此本文件无需再做正则清洗；
 * 3. 唯一需要「原始值 → 可打印值」转换的是房间号，它已在 `shared` 的
 *    `maskRoom()` 里完成，本文件只打印 `LogEvent` 里已经打码后的值。
 *
 * 除业务事件外，WebRTC 底层的「无法解析的报文 / 数据通道异常」也统一收敛到这里
 * （`createDiagnosticSink`），并且**只上报事件名，绝不上报原始报文内容**。
 */

import type { LogEvent, Logger } from '@webrtc-gomoku/shared';

import type { ClientDiagnostic } from '../webrtc';

/** 日志级别（决定走 console 的哪个方法） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 实际写日志的下沉接口。
 *
 * 抽出接口是为了让单测与「静默模式」都能替换掉 `console`，
 * 从而保证 `packages/web/src/connection/*.ts` 里除本文件外没有 `console.*`。
 */
export interface LogSink {
  debug(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

/** `createLogger` 的可选配置 */
export interface LoggerOptions {
  /** 自定义下沉（默认 console） */
  sink?: LogSink;
  /** 是否真正打印（默认 true；生产可用 ?debug=0 关掉） */
  enabled?: boolean;
  /** 行首前缀，便于在控制台过滤 */
  prefix?: string;
}

/** 默认前缀：只出现一处字面量，避免各处拼装风格不一致 */
const DEFAULT_PREFIX = '[gomoku-conn]';

/** 默认下沉：console（唯一允许调用 console 的地方） */
const CONSOLE_SINK: LogSink = {
  debug(line: string): void {
    console.debug(line);
  },
  info(line: string): void {
    console.info(line);
  },
  warn(line: string): void {
    console.warn(line);
  },
  error(line: string): void {
    console.error(line);
  },
};

/** 事件 → 级别映射（失败类必须可被 warn 过滤出来） */
const LEVEL_OF: Record<LogEvent['ev'], LogLevel> = {
  'conn.state': 'debug',
  'conn.retry': 'info',
  'conn.restore': 'info',
  'conn.fail': 'warn',
  'conn.compat': 'info',
  'conn.sync-reject': 'warn',
};

/**
 * 穷尽性守卫：新增 `LogEvent` 变体却忘记写格式化分支时，编译期直接报错。
 */
function assertNever(value: never): never {
  throw new Error(`未处理的日志事件：${String(value)}`);
}

/**
 * 把结构化事件格式化成单行文本。
 *
 * 逐事件显式列出字段顺序（而不是 `Object.entries` 遍历）：
 * 这样「多打一个字段」必须改代码，脱敏白名单不会被反射式遍历绕过。
 */
function formatEvent(e: LogEvent): string {
  switch (e.ev) {
    case 'conn.state':
      return `ev=conn.state from=${e.from} to=${e.to} attempt=${e.attempt} reason=${
        e.reason ?? 'none'
      } sinceMs=${e.sinceMs}`;
    case 'conn.retry':
      return `ev=conn.retry attempt=${e.attempt} delayMs=${e.delayMs} reason=${e.reason} urlHost=${e.urlHost}`;
    case 'conn.restore':
      return `ev=conn.restore attempt=${e.attempt} totalMs=${e.totalMs} via=${e.via} movesSynced=${e.movesSynced}`;
    case 'conn.fail':
      return `ev=conn.fail reason=${e.reason} attempt=${e.attempt} totalMs=${e.totalMs} online=${e.online} visibility=${e.visibility}`;
    case 'conn.compat':
      return `ev=conn.compat server=${e.server}`;
    case 'conn.sync-reject':
      return `ev=conn.sync-reject rev=${e.rev} at=${e.at}`;
    default:
      return assertNever(e);
  }
}

/**
 * 创建客户端日志器（`Logger` 的浏览器实现）。
 *
 * @param options 下沉 / 开关 / 前缀
 * @returns 供编排器（`ConnectionManager`）注入使用的 `Logger`
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? CONSOLE_SINK;
  const enabled = options.enabled ?? true;
  const prefix = options.prefix ?? DEFAULT_PREFIX;

  return {
    log(e: LogEvent): void {
      if (!enabled) return;
      const line = `${prefix} ${formatEvent(e)}`;
      const level: LogLevel = LEVEL_OF[e.ev] ?? 'info';
      switch (level) {
        case 'debug':
          sink.debug(line);
          break;
        case 'info':
          sink.info(line);
          break;
        case 'warn':
          sink.warn(line);
          break;
        case 'error':
          sink.error(line);
          break;
        default:
          assertNever(level);
      }
    },
  };
}

/** 诊断事件 → 人类可读文案（**不包含任何原始报文**） */
function formatDiagnostic(d: ClientDiagnostic): string {
  switch (d.kind) {
    case 'dc-error':
      return '数据通道异常（已忽略；原始错误对象不落日志）';
    case 'dc-parse-failed':
      return '收到无法解析的局内消息（已丢弃；原始报文不落日志）';
    default:
      return assertNever(d);
  }
}

/**
 * 创建底层诊断下沉（替代 `webrtc.ts` 里原先的 `console.warn/error`）。
 *
 * @param sink 自定义下沉（默认 console）
 * @param prefix 行首前缀
 * @returns 可直接传给 `WebRTCClientOptions.onDiagnostic` 的函数
 */
export function createDiagnosticSink(
  sink: LogSink = CONSOLE_SINK,
  prefix: string = DEFAULT_PREFIX
): (d: ClientDiagnostic) => void {
  return (d: ClientDiagnostic): void => {
    sink.warn(`${prefix} ${formatDiagnostic(d)}`);
  };
}
