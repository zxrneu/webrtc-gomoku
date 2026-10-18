import type { Clock } from '@webrtc-gomoku/shared';

/**
 * 可手工推进的假时钟（web 层测试专用）
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

/**
 * 最小 WebSocket 替身：不启动任何真实网络
 */
export class FakeWebSocket {
  public static readonly instances: FakeWebSocket[] = [];
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readyState = 0;
  public onopen: (() => void) | null = null;
  public onmessage: ((e: { data: string }) => void) | null = null;
  public onclose: ((e: { code: number }) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public readonly sent: string[] = [];
  public closed = false;

  public constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** 模拟握手成功 */
  public open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** 模拟收到一条 JSON 报文 */
  public message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  /** 模拟对端/网络关闭 */
  public serverClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** 模拟 socket 错误 */
  public fail(): void {
    this.onerror?.({ type: 'error' });
  }

  /** 已发送报文解析后的 `t` 序列 */
  public get sentTypes(): string[] {
    return this.sent.map((raw) => {
      try {
        return String((JSON.parse(raw) as { t?: unknown }).t ?? '');
      } catch {
        return '';
      }
    });
  }
}

/** 最小 DataChannel 替身 */
export class FakeDataChannel {
  public readyState = 'connecting';
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public onmessage: ((e: { data: string }) => void) | null = null;
  public closed = false;
  public readonly sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
    this.readyState = 'closed';
  }

  public open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  public message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  public get sentTypes(): string[] {
    return this.sent.map((raw) => {
      try {
        return String((JSON.parse(raw) as { t?: unknown }).t ?? '');
      } catch {
        return '';
      }
    });
  }
}

/** 最小 RTCPeerConnection 替身：记录调用参数与实例数 */
export class FakePeerConnection {
  public static instances: FakePeerConnection[] = [];
  public static last: FakePeerConnection | null = null;

  public connectionState = 'new';
  public iceConnectionState = 'new';
  public signalingState = 'stable';
  public localDescription: { type: string; sdp: string } | null = null;
  public remoteDescription: { type: string; sdp: string } | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public oniceconnectionstatechange: (() => void) | null = null;
  public onsignalingstatechange: (() => void) | null = null;
  public onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  public ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null;
  public closed = false;
  public readonly channel = new FakeDataChannel();
  public readonly offerOptions: unknown[] = [];
  public readonly answerCalls: number[] = [];
  public restartIceCalls = 0;

  public constructor(public readonly config: unknown) {
    FakePeerConnection.instances.push(this);
    FakePeerConnection.last = this;
  }

  public createDataChannel(): FakeDataChannel {
    return this.channel;
  }

  public async createOffer(options?: unknown): Promise<{ type: string; sdp: string }> {
    this.offerOptions.push(options);
    return { type: 'offer', sdp: 'v=0 fake offer' };
  }

  public async createAnswer(): Promise<{ type: string; sdp: string }> {
    this.answerCalls.push(Date.now());
    return { type: 'answer', sdp: 'v=0 fake answer' };
  }

  public async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.localDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  public async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  public async addIceCandidate(): Promise<void> {
    /* 记录型替身：不做事 */
  }

  public restartIce(): void {
    this.restartIceCalls += 1;
  }

  public close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  public getStats(): Map<string, unknown> {
    return new Map();
  }

  /** 模拟连接状态变化 */
  public setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}
