import type {
  ClientSignalingMsg,
  GameMessage,
  ServerSignalingMsg,
} from '../../../src/types';
import type { LogEvent } from '../../../src/reconnect/log';
import type { Clock, P2pEvent, P2pTransport, SignalEvent, SignalTransport } from '../../../src/reconnect/ports';

/**
 * 可手工推进的假时钟：让「退避 / 超时 / 心跳」在 Node 里以确定性方式演化。
 * 不依赖 vi.useFakeTimers()，避免全局状态互相污染。
 */
export class FakeClock implements Clock {
  private current = 0;
  private seq = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): number {
    const handle = this.seq++;
    this.timers.set(handle, { at: this.current + Math.max(0, ms), fn });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  /** 把时间推进 ms，并顺序执行期间到期的定时器 */
  advance(ms: number): void {
    const target = this.current + Math.max(0, ms);
    for (let guard = 0; guard < 10000; guard++) {
      let nextHandle = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [handle, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextHandle = handle;
        }
      }
      if (nextHandle < 0) break;
      const timer = this.timers.get(nextHandle);
      this.timers.delete(nextHandle);
      if (!timer) break;
      this.current = timer.at;
      timer.fn();
    }
    this.current = target;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

/** 假信令通道：记录所有上行消息，可手工注入服务端事件 */
export class FakeSignal implements SignalTransport {
  public readyState: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  public connectCalls = 0;
  public closeCalls = 0;
  public readonly sent: ClientSignalingMsg[] = [];
  public lastUrl = '';
  private cb: ((e: SignalEvent) => void) | null = null;

  connect(url: string, _timeoutMs: number): void {
    this.connectCalls++;
    this.lastUrl = url;
    this.readyState = 'connecting';
  }

  close(_code?: number): void {
    this.closeCalls++;
    this.readyState = 'closed';
  }

  send(msg: ClientSignalingMsg): boolean {
    this.sent.push(msg);
    return this.readyState === 'open';
  }

  onEvent(cb: (e: SignalEvent) => void): void {
    this.cb = cb;
  }

  emit(e: SignalEvent): void {
    if (e.type === 'open') this.readyState = 'open';
    if (e.type === 'closed') this.readyState = 'closed';
    this.cb?.(e);
  }

  open(): void {
    this.emit({ type: 'open' });
  }

  drop(code = 1006): void {
    this.emit({ type: 'closed', code, intentional: false });
  }

  server(msg: ServerSignalingMsg): void {
    this.emit({ type: 'msg', msg });
  }
}

/** 假 P2P 通道：可编程 DC 开关与发送结果 */
export class FakeP2p implements P2pTransport {
  public dcOpen = false;
  public restartIceCalls = 0;
  public readonly rebuildCalls: boolean[] = [];
  public readonly attached: boolean[] = [];
  public readonly applied: unknown[] = [];
  public readonly sent: GameMessage[] = [];
  private cb: ((e: P2pEvent) => void) | null = null;

  attach(isInitiator: boolean): void {
    this.attached.push(isInitiator);
  }

  async restartIce(): Promise<void> {
    this.restartIceCalls++;
  }

  async rebuild(isInitiator: boolean): Promise<void> {
    this.rebuildCalls.push(isInitiator);
  }

  async applyRemoteSignal(data: unknown): Promise<void> {
    this.applied.push(data);
  }

  send(msg: GameMessage): boolean {
    if (!this.dcOpen) return false;
    this.sent.push(msg);
    return true;
  }

  isDcOpen(): boolean {
    return this.dcOpen;
  }

  onEvent(cb: (e: P2pEvent) => void): void {
    this.cb = cb;
  }

  close(): void {
    this.dcOpen = false;
  }

  emit(e: P2pEvent): void {
    this.cb?.(e);
  }

  openDc(): void {
    this.dcOpen = true;
    this.emit({ type: 'dc-open' });
  }

  dropDc(): void {
    this.dcOpen = false;
    this.emit({ type: 'dc-closed' });
  }
}

/** 收集型 logger：直接断言事件序列与字段 */
export class CollectingLogger {
  public readonly logs: LogEvent[] = [];

  log(e: LogEvent): void {
    this.logs.push(e);
  }

  of(event: LogEvent['ev']): LogEvent[] {
    return this.logs.filter((e) => e.ev === event);
  }
}
