import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_POLICY, type P2pEvent } from '@webrtc-gomoku/shared';

import { createP2pTransport } from '../../src/connection/p2pTransport';
import { WebRTCClient } from '../../src/webrtc';

import { FakeClock, FakePeerConnection } from './fakes';

interface Ctx {
  clock: FakeClock;
  events: P2pEvent[];
  signals: unknown[];
  client: WebRTCClient;
  transport: ReturnType<typeof createP2pTransport>;
  pc: () => FakePeerConnection;
}

function setup(): Ctx {
  const clock = new FakeClock();
  const events: P2pEvent[] = [];
  const signals: unknown[] = [];
  const client = new WebRTCClient({
    onMessage: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
  });
  const transport = createP2pTransport({
    clock,
    policy: DEFAULT_POLICY,
    client,
    signalOut: (data) => signals.push(data),
  });
  transport.onEvent((e) => events.push(e));
  return {
    clock,
    events,
    signals,
    client,
    transport,
    pc: () => {
      const last = FakePeerConnection.last;
      if (!last) throw new Error('尚未创建 PeerConnection');
      return last;
    },
  };
}

describe('p2pTransport · PC 状态去抖（M3 误报基线）', () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    FakePeerConnection.last = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connectionState=disconnected 后 4.9s 不报、5.0s 报 pc-disconnected-settled', () => {
    const ctx = setup();
    ctx.transport.attach(true);

    ctx.pc().setConnectionState('disconnected');
    ctx.clock.advance(4900);
    expect(ctx.events.some((e) => e.type === 'pc-disconnected-settled')).toBe(false);

    ctx.clock.advance(100);
    expect(ctx.events).toContainEqual({ type: 'pc-disconnected-settled' });
  });

  it('disconnected 在 5s 内回到 connected 则不报（3s 抖动零提示）', () => {
    const ctx = setup();
    ctx.transport.attach(true);

    ctx.pc().setConnectionState('disconnected');
    ctx.clock.advance(3000);
    ctx.pc().setConnectionState('connected');
    ctx.clock.advance(10000);

    expect(ctx.events.some((e) => e.type === 'pc-disconnected-settled')).toBe(false);
  });

  it('connectionState=failed 立即上报 pc-failed（不去抖）', () => {
    const ctx = setup();
    ctx.transport.attach(true);

    ctx.pc().setConnectionState('failed');

    expect(ctx.events).toContainEqual({ type: 'pc-failed' });
  });
});

describe('p2pTransport · ICE restart（ADR-2）', () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    FakePeerConnection.last = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restartIce 只 createOffer({iceRestart:true}) 且 PC 实例不变', async () => {
    const ctx = setup();
    ctx.transport.attach(true);
    expect(FakePeerConnection.instances).toHaveLength(1);

    await ctx.transport.restartIce();

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(ctx.pc().restartIceCalls).toBe(1);
    expect(ctx.pc().offerOptions).toContainEqual({ iceRestart: true });
    expect(ctx.signals).toContainEqual(
      expect.objectContaining({ kind: 'offer', iceRestart: true })
    );
  });

  it('rebuild 新建 PC 并发出带 rebuild 标记的 offer', async () => {
    const ctx = setup();
    ctx.transport.attach(true);
    expect(FakePeerConnection.instances).toHaveLength(1);

    await ctx.transport.rebuild(true);

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(ctx.pc().offerOptions).toContainEqual(undefined);
    expect(ctx.signals).toContainEqual(expect.objectContaining({ kind: 'offer', rebuild: true }));
  });

  it('attach(false) 不创建 offer（加入方只应答，结构性消除 glare）', () => {
    const ctx = setup();

    ctx.transport.attach(false);

    expect(ctx.signals).toHaveLength(0);
  });

  it('收到 offer 时复用现有 PC 并回 answer', async () => {
    const ctx = setup();
    ctx.transport.attach(false);

    await ctx.transport.applyRemoteSignal({ kind: 'offer', sdp: 'v=0 remote offer' });

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(ctx.signals).toContainEqual(expect.objectContaining({ kind: 'answer' }));
  });

  it('收到带 rebuild 标记的 offer 时新建 PC（对端已全量重建）', async () => {
    const ctx = setup();
    ctx.transport.attach(false);
    expect(FakePeerConnection.instances).toHaveLength(1);

    await ctx.transport.applyRemoteSignal({ kind: 'offer', sdp: 'v=0 remote offer', rebuild: true });

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(ctx.signals).toContainEqual(expect.objectContaining({ kind: 'answer' }));
  });

  it('加入方由远端 offer 首次建 PC 后会转发本地 ICE 候选', async () => {
    const ctx = setup();
    ctx.transport.close();
    await ctx.transport.applyRemoteSignal({ kind: 'offer', sdp: 'v=0 remote offer' });
    const candidate = { candidate: 'candidate:guest', sdpMid: '0' };

    ctx.pc().onicecandidate?.({ candidate });

    expect(ctx.signals).toContainEqual({ kind: 'ice', candidate });
  });

  it('关闭连接后未完成的 ICE restart 不再向新房间发送 offer', async () => {
    const ctx = setup();
    ctx.transport.attach(true);
    await Promise.resolve();
    await Promise.resolve();
    const pending = ctx.transport.restartIce();
    ctx.transport.close();
    ctx.signals.length = 0;

    await pending;

    expect(ctx.signals).toEqual([]);
  });
});

describe('p2pTransport · DC 心跳', () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    FakePeerConnection.last = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('DC 打开后每 5s 发一次 DC ping，收到 pong 后不判死', () => {
    const ctx = setup();
    ctx.transport.attach(true);
    ctx.pc().channel.open();
    expect(ctx.events).toContainEqual({ type: 'dc-open' });

    ctx.clock.advance(5000);
    expect(ctx.pc().channel.sentTypes.filter((t) => t === 'ping')).toHaveLength(1);

    // 健康对端：每次探测都应答。连续应答期间绝不判死（dc心跳×2 才算断，见架构 §6）
    for (let i = 0; i < 4; i++) {
      ctx.pc().channel.message({ t: 'pong', ts: i });
      ctx.clock.advance(5000);
    }

    expect(ctx.events.some((e) => e.type === 'pc-disconnected-settled')).toBe(false);
    // ping / pong 属于控制消息，不上报业务层
    expect(ctx.events.some((e) => e.type === 'msg')).toBe(false);
  });

  it('从未收到 DC pong 且 pc=connected 且 dc=open 时判定对端为 v1，关闭 DC 心跳不误报', () => {
    const ctx = setup();
    ctx.transport.attach(true);
    ctx.pc().setConnectionState('connected');
    ctx.pc().channel.open();

    ctx.clock.advance(20000);
    const pingsAfterDetection = ctx.pc().channel.sentTypes.filter((t) => t === 'ping').length;

    expect(ctx.events.some((e) => e.type === 'pc-disconnected-settled')).toBe(false);
    expect(pingsAfterDetection).toBeGreaterThan(0);

    // 心跳已关闭：不再继续发 ping
    ctx.clock.advance(20000);
    expect(ctx.pc().channel.sentTypes.filter((t) => t === 'ping')).toHaveLength(pingsAfterDetection);
  });

  it('收到 ping 时立即回 pong', () => {
    const ctx = setup();
    ctx.transport.attach(true);
    ctx.pc().channel.open();

    ctx.pc().channel.message({ t: 'ping', ts: 42 });

    expect(ctx.pc().channel.sentTypes).toContain('pong');
  });

  it('DC 关闭时上报 dc-closed 并停止心跳', () => {
    const ctx = setup();
    ctx.transport.attach(true);
    ctx.pc().channel.open();

    ctx.pc().channel.readyState = 'closed';
    ctx.pc().channel.onclose?.();

    expect(ctx.events).toContainEqual({ type: 'dc-closed' });
    const pings = ctx.pc().channel.sentTypes.filter((t) => t === 'ping').length;
    ctx.clock.advance(20000);
    expect(ctx.pc().channel.sentTypes.filter((t) => t === 'ping')).toHaveLength(pings);
  });
});

describe('p2pTransport · 发送与探针', () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    FakePeerConnection.last = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isDcOpen 反映 DC 是否 open（供编排器区分 ws-only 恢复）', () => {
    const ctx = setup();
    ctx.transport.attach(true);
    expect(ctx.transport.isDcOpen()).toBe(false);

    ctx.pc().channel.open();
    expect(ctx.transport.isDcOpen()).toBe(true);
  });

  it('DC 未开时 send 返回 false（落子失败必须可见）', () => {
    const ctx = setup();
    ctx.transport.attach(true);

    expect(ctx.transport.send({ t: 'move', x: 7, y: 7 })).toBe(false);
  });

  it('close 后不再上报任何事件（防串台）', () => {
    const ctx = setup();
    ctx.transport.attach(true);
    const before = ctx.events.length;

    ctx.transport.close();
    ctx.pc().setConnectionState('failed');
    ctx.clock.advance(20000);

    expect(ctx.events).toHaveLength(before);
  });
});

/**
 * 回归：编排器 `startSession()` 会先 `p2p.close()` 清场，再建立新会话。
 * 若 `close()` 做成「一次性销毁标志」，后续 attach/applyRemoteSignal 会被永久静音：
 * - 房主：建了 PC 却永远不发 offer（卡在 NEGOTIATING）
 * - 加入方：**从不调用 attach()**（只等 offer），若 applyRemoteSignal 也被静音，
 *   则永远不建 PC、不回 answer —— 表现为「房主发 offer 无人应答」。
 */
describe('p2pTransport · close 后可重新武装（startSession 先 close 再建连）', () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    FakePeerConnection.last = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('close 之后 attach(true) 仍会发出 offer（房主不被永久静音）', async () => {
    const ctx = setup();
    ctx.transport.attach(true);
    ctx.transport.close();
    ctx.signals.length = 0;

    ctx.transport.attach(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.signals).toContainEqual(expect.objectContaining({ kind: 'offer' }));
  });

  it('close 之后收到远端 offer 仍会建 PC 并回 answer（加入方不被永久静音）', async () => {
    const ctx = setup();
    ctx.transport.attach(false);
    ctx.transport.close();
    const before = FakePeerConnection.instances.length;

    await ctx.transport.applyRemoteSignal({ kind: 'offer', sdp: 'v=0 remote offer' });

    expect(FakePeerConnection.instances.length).toBe(before + 1);
    expect(ctx.signals).toContainEqual(expect.objectContaining({ kind: 'answer' }));
  });

  it('close 之后 applyRemoteSignal 会恢复事件上报（解除静音）', async () => {
    const ctx = setup();
    ctx.transport.attach(false);
    ctx.transport.close();
    const before = ctx.events.length;

    await ctx.transport.applyRemoteSignal({ kind: 'offer', sdp: 'v=0 remote offer' });
    ctx.pc().setConnectionState('failed');

    expect(ctx.events.length).toBeGreaterThan(before);
    expect(ctx.events).toContainEqual({ type: 'pc-failed' });
  });
});
