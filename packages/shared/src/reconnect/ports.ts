/**
 * ============================================================================
 * 重连能力的「注入接缝」（Dependency Inversion，AGENTS §2 D）
 * ============================================================================
 * `shared` 层不允许出现 `Date.now()` / `setTimeout()` / `WebSocket` /
 * `RTCPeerConnection`。所有 IO 能力都以接口形式声明在这里，
 * 具体实现在 `packages/web/src/connection/*`（浏览器）或单测替身（Node）。
 *
 * 这样编排器（orchestrator）虽然是「有状态的流程代码」，但依赖全部可替换，
 * 因此可以在 Node 里毫秒级跑完，不启动任何真实网络。
 */

import type { ClientSignalingMsg, GameMessage, ServerSignalingMsg } from '../types';

/**
 * 注入的时钟：禁止在 shared 内直接 Date.now / setTimeout
 */
export interface Clock {
  /** 当前时刻（epoch 毫秒） */
  now(): number;
  /** 延时执行，返回可取消的句柄 */
  setTimeout(fn: () => void, ms: number): number;
  /** 取消延时任务 */
  clearTimeout(handle: number): void;
}

/**
 * 浏览器 `RTCPeerConnection.connectionState` 的字面量集合。
 *
 * 刻意不直接引用 DOM 的 `RTCPeerConnectionState` 类型：`shared` 必须零 DOM 依赖
 * （即使只是类型引用，也会把 DOM lib 拖进 shared 的编译面）。两个联合结构完全一致，
 * 因此 web 层可以直接把原生状态传进来。
 */
export type PcConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

/**
 * 信令通道抽象：web 用 WebSocket 实现，单测用假实现
 */
export interface SignalTransport {
  /** 发起连接；timeoutMs 内未 open 则自身 emit `connect-timeout` */
  connect(url: string, timeoutMs: number): void;
  /** 主动关闭（intentional=true 表示用户行为，不再重连） */
  close(code?: number): void;
  /** 发送一条上行信令消息；返回是否真正写入 socket */
  send(msg: ClientSignalingMsg): boolean;
  /** 单一事件回调（不做多播，避免监听器泄漏） */
  onEvent(cb: (e: SignalEvent) => void): void;
  readonly readyState: 'idle' | 'connecting' | 'open' | 'closed';
}

/**
 * 信令通道向上报告的事件
 */
export type SignalEvent =
  | { type: 'open' }
  | { type: 'closed'; code: number; intentional: boolean }
  | { type: 'error'; detail: 'connect-failed' | 'socket-error' }
  | { type: 'connect-timeout' }
  | { type: 'msg'; msg: ServerSignalingMsg }
  /** 命中「旧服务端」探测：服务端回了未知消息类型 */
  | { type: 'probe-unsupported'; probe: 'ping' | 'resume' }
  /** 应用层心跳连续 miss 达阈值（对应 FailReason.WS_TIMEOUT） */
  | { type: 'heartbeat-dead' };

/**
 * P2P 通道抽象：web 用 WebRTCClient 实现
 */
export interface P2pTransport {
  /** 建立（或重建）本地 PC；isInitiator=true 表示房主（恒为 offerer） */
  attach(isInitiator: boolean): void;
  /** ICE restart：复用现有 PC，只做一次 offer/answer 往返 */
  restartIce(): Promise<void>;
  /** 全量重建：新建 PC（会销毁旧 PC） */
  rebuild(isInitiator: boolean): Promise<void>;
  /** 应用对端经信令转发来的 offer/answer/ice */
  applyRemoteSignal(data: unknown): Promise<void>;
  /** 发送一条局内消息；返回 DC 是否处于 open */
  send(msg: GameMessage): boolean;
  /**
   * DC 是否处于 open。
   * 只读探针，用于区分「WS 断开但 P2P 仍活（ws-only 恢复）」与「需要 ICE restart」。
   */
  isDcOpen(): boolean;
  onEvent(cb: (e: P2pEvent) => void): void;
  close(): void;
}

/**
 * P2P 通道向上报告的事件
 */
export type P2pEvent =
  | { type: 'dc-open' }
  | { type: 'dc-closed' }
  | { type: 'pc-state'; state: PcConnectionState }
  /** `disconnected` 持续 ≥ disconnectedGraceMs 后由适配器发出（M3 误报基线） */
  | { type: 'pc-disconnected-settled' }
  | { type: 'pc-failed' }
  | { type: 'msg'; msg: GameMessage }
  /** 适配器需要经信令转发的 offer/answer/ice */
  | { type: 'signal-out'; data: unknown }
  | { type: 'ice-restart-failed' };
