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
}

class FakePeerConnection {
  public static instances: FakePeerConnection[] = [];

  public connectionState = 'new';
  public iceConnectionState = 'new';
  public signalingState = 'stable';
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

  public close(): void {
    this.closed = true;
  }

  public getStats(): Map<string, unknown> {
    return new Map();
  }
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
