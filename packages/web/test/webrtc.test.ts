import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { GameMessage } from '@webrtc-gomoku/shared';

import { WebRTCClient } from '../src/webrtc';

/**
 * 最小 RTCPeerConnection 替身：只记录事件处理器与关闭状态，不做任何真实网络。
 * 用于验证「换房时旧连接的迟到事件不得污染新房间」这一契约。
 */
class FakeDataChannel {
  public readyState = 'connecting';
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public onmessage: ((e: { data: string }) => void) | null = null;
  public closed = false;
  public sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
    this.readyState = 'closed';
  }

  /** 模拟通道就绪（v1.1 事件通道用例需要） */
  public open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
}

class FakePeerConnection {
  public static instances: FakePeerConnection[] = [];

  public connectionState = 'new';
  public iceConnectionState = 'new';
  public signalingState = 'stable';
  public localDescription: { type: string; sdp: string } | null = null;
  public remoteDescription: { type: string; sdp: string } | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public oniceconnectionstatechange: (() => void) | null = null;
  public onsignalingstatechange: (() => void) | null = null;
  public onicecandidate: ((e: unknown) => void) | null = null;
  public ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null;
  public closed = false;
  public channel = new FakeDataChannel();

  public constructor(public readonly config: unknown) {
    FakePeerConnection.instances.push(this);
  }

  public createDataChannel(): FakeDataChannel {
    return this.channel;
  }

  public async createOffer(options?: unknown): Promise<{ type: string; sdp: string }> {
    FakePeerConnection.offerOptions.push(options);
    return { type: 'offer', sdp: 'v=0 local offer' };
  }

  public async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.localDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  public async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  public close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  /** 记录 ICE restart 调用次数（v1.1 用例需要） */
  public restartIce(): void {
    this.restartIceCalls += 1;
  }

  public getStats(): Map<string, unknown> {
    return new Map();
  }

  public restartIceCalls = 0;
  public static offerOptions: unknown[] = [];
}

interface ClientHarness {
  client: WebRTCClient;
  calls: { connected: number; disconnected: number };
  received: GameMessage[];
}

function createClient(): ClientHarness {
  const calls = { connected: 0, disconnected: 0 };
  const received: GameMessage[] = [];
  const client = new WebRTCClient({
    onMessage: (msg) => received.push(msg),
    onConnected: () => {
      calls.connected++;
    },
    onDisconnected: () => {
      calls.disconnected++;
    },
  });
  return { client, calls, received };
}

function asFake(pc: RTCPeerConnection): FakePeerConnection {
  return pc as unknown as FakePeerConnection;
}

describe('WebRTCClient 换房生命周期', () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('close() 后旧 PeerConnection 的断线事件不再回调 onDisconnected', () => {
    const { client, calls } = createClient();
    const pc = asFake(client.initPeer(true));

    client.close();
    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange?.();
    pc.connectionState = 'failed';
    pc.onconnectionstatechange?.();

    expect(calls.disconnected).toBe(0);
  });

  it('close() 后旧 DataChannel 的 close/message 事件不再回调（旧房间消息不串台）', () => {
    const { client, calls, received } = createClient();
    const pc = asFake(client.initPeer(true));
    const dc = pc.channel;

    client.close();
    dc.onclose?.();
    dc.onmessage?.({ data: JSON.stringify({ t: 'hello', name: '上一局对手' }) });

    expect(calls.disconnected).toBe(0);
    expect(received).toEqual([]);
  });

  it('close() 关闭并释放旧 pc/dc，同时清空 ICE 候选缓存', () => {
    const { client } = createClient();
    const pc = asFake(client.initPeer(true));
    client.pendingIce.push({ candidate: 'candidate:1' });

    client.close();

    expect(pc.closed).toBe(true);
    expect(pc.channel.closed).toBe(true);
    expect(client.pc).toBeNull();
    expect(client.dc).toBeNull();
    expect(client.pendingIce).toEqual([]);
  });

  it('initPeer 换房时先关闭上一连接（绝不复用上局 pc）', () => {
    const { client } = createClient();
    const first = asFake(client.initPeer(true));
    const second = client.initPeer(false);

    expect(first.closed).toBe(true);
    expect(client.pc).toBe(second);
  });
});

/**
 * v1.1 重连协商：`applyRemoteOffer` 必须「能复用就复用」。
 * 若在恢复流程里误用 `initPeer(false)`（首行 this.close()），正在恢复的 PC 会被销毁，
 * 表现为「ICE restart 永远失败」—— 这是本次改造最贵的坑，必须有回归用例锁住。
 */
describe('WebRTCClient 重连协商（v1.1）', () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    FakePeerConnection.offerOptions = [];
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('applyRemoteOffer 在 signalingState=stable 时复用现有 PC，不 close', async () => {
    const { client } = createClient();
    const pc = asFake(client.initPeer(false));

    await client.applyRemoteOffer({ type: 'offer', sdp: 'v=0 remote' });

    expect(pc.closed).toBe(false);
    expect(client.pc).toBe(pc);
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'v=0 remote' });
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('applyRemoteOffer 在 signalingState!=stable 时才 initPeer(false)', async () => {
    const { client } = createClient();
    const pc = asFake(client.initPeer(false));
    pc.signalingState = 'have-local-offer';

    await client.applyRemoteOffer({ type: 'offer', sdp: 'v=0 remote2' });

    expect(pc.closed).toBe(true);
    expect(client.pc).not.toBe(pc);
    expect(FakePeerConnection.instances).toHaveLength(2);
  });

  it('applyRemoteOffer 在完全没有 PC 时创建应答方 PC', async () => {
    const { client } = createClient();

    const pc = await client.applyRemoteOffer({ type: 'offer', sdp: 'v=0 remote3' });

    expect(client.pc).toBe(pc);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(asFake(pc).remoteDescription).toEqual({ type: 'offer', sdp: 'v=0 remote3' });
  });

  it('restartIce 复用现有 PC 且 createOffer({iceRestart:true})', async () => {
    const { client } = createClient();
    const pc = asFake(client.initPeer(true));

    const desc = await client.restartIce();

    expect(client.pc).toBe(pc);
    expect(pc.closed).toBe(false);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(FakePeerConnection.offerOptions).toContainEqual({ iceRestart: true });
    expect(desc.type).toBe('offer');
  });

  it('没有 PC 时 restartIce 抛错（由编排器降级为 rebuild）', async () => {
    const { client } = createClient();

    await expect(client.restartIce()).rejects.toThrow();
  });

  it('transport 事件通道把 dc-open / dc-closed / msg 透出给适配器', () => {
    const { client } = createClient();
    const seen: string[] = [];
    client.onTransportEvent((e) => seen.push(e.type));
    const pc = asFake(client.initPeer(true));

    pc.channel.open();
    pc.channel.onmessage?.({ data: JSON.stringify({ t: 'move', x: 1, y: 2 }) });
    pc.channel.onclose?.();

    expect(seen).toEqual(['dc-open', 'msg', 'dc-closed']);
  });
});
