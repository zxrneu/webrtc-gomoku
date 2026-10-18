import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_POLICY, type SignalEvent } from '@webrtc-gomoku/shared';

import { createWsTransport } from '../../src/connection/wsTransport';

import { FakeClock, FakeWebSocket } from './fakes';

interface Ctx {
  clock: FakeClock;
  events: SignalEvent[];
  transport: ReturnType<typeof createWsTransport>;
  ws: () => FakeWebSocket;
}

function setup(): Ctx {
  const clock = new FakeClock();
  const events: SignalEvent[] = [];
  const transport = createWsTransport({ clock, policy: DEFAULT_POLICY });
  transport.onEvent((e) => events.push(e));
  return {
    clock,
    events,
    transport,
    ws: () => {
      const last = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      if (!last) throw new Error('尚未创建 WebSocket');
      return last;
    },
  };
}

/** 已发送的 ping 条数 */
function pingCount(ws: FakeWebSocket): number {
  return ws.sentTypes.filter((t) => t === 'ping').length;
}

describe('wsTransport · 连接生命周期', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connect 后 open 时上报 open 事件', () => {
    const ctx = setup();

    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    expect(ctx.transport.readyState).toBe('connecting');

    ctx.ws().open();

    expect(ctx.transport.readyState).toBe('open');
    expect(ctx.events).toEqual([{ type: 'open' }]);
  });

  it('connect 超过超时时间仍未 open 时上报 connect-timeout 并关闭 socket', () => {
    const ctx = setup();

    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.clock.advance(5000);

    expect(ctx.events).toContainEqual({ type: 'connect-timeout' });
    expect(ctx.ws().closed).toBe(true);
  });

  it('网络关闭时上报 closed 且 intentional=false', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();

    ctx.ws().serverClose(1006);

    expect(ctx.events).toContainEqual({ type: 'closed', code: 1006, intentional: false });
    expect(ctx.transport.readyState).toBe('closed');
  });

  it('主动 close 时上报 closed 且 intentional=true', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();

    ctx.transport.close(1000);

    expect(ctx.events).toContainEqual({ type: 'closed', code: 1000, intentional: true });
  });

  it('socket 未 open 时 send 返回 false', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);

    expect(ctx.transport.send({ t: 'ping' })).toBe(false);
  });

  it('open 后 send 把消息写入 socket 并返回 true', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();

    expect(ctx.transport.send({ t: 'create', room: 'A8B2' })).toBe(true);
    expect(ctx.ws().sentTypes).toContain('create');
  });
});

describe('wsTransport · 应用层心跳（L2）', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('open 后每 5s 发一次 ping，收到 pong 后 misses 归零', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();

    expect(pingCount(ctx.ws())).toBe(0);
    ctx.clock.advance(5000);
    expect(pingCount(ctx.ws())).toBe(1);

    // 在途探测未回：进入 miss 窗口，不重复发
    ctx.clock.advance(5000);
    expect(pingCount(ctx.ws())).toBe(1);

    // 下一个间隔再发一次
    ctx.clock.advance(5000);
    expect(pingCount(ctx.ws())).toBe(2);

    // 收到 pong → misses 归零，心跳继续按间隔运行
    ctx.ws().message({ t: 'pong', ts: 1 });
    ctx.clock.advance(5000);
    expect(pingCount(ctx.ws())).toBe(3);
    ctx.clock.advance(5000);
    expect(ctx.events.some((e) => e.type === 'heartbeat-dead')).toBe(false);
  });

  it('连续 2 次 3s 超时后上报 heartbeat-dead（对齐 M4 ≤16s）', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();

    ctx.clock.advance(20000);

    expect(ctx.events).toContainEqual({ type: 'heartbeat-dead' });
  });

  it('收到 ping 之外的消息照常上报 msg', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();

    ctx.ws().message({ t: 'peer-online' });

    expect(ctx.events).toContainEqual({ type: 'msg', msg: { t: 'peer-online' } });
  });

  it('非 JSON / 缺少 t 的报文被静默忽略', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();
    const before = ctx.events.length;

    ctx.ws().onmessage?.({ data: 'not-json' });
    ctx.ws().message({ hello: 1 });

    expect(ctx.events).toHaveLength(before);
  });
});

describe('wsTransport · 旧服务端兼容探测（K8-2）', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('收到「未知消息类型」且 probe=ping 时 emit probe-unsupported 并停心跳', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();
    ctx.clock.advance(5000);
    expect(pingCount(ctx.ws())).toBe(1);

    ctx.ws().message({ t: 'error', message: '未知消息类型' });

    expect(ctx.events).toContainEqual({ type: 'probe-unsupported', probe: 'ping' });
    // 该 error 不再作为普通消息上报（否则业务层会误弹「未知消息类型」）
    expect(ctx.events.some((e) => e.type === 'msg')).toBe(false);

    // 心跳已关闭：再推进 30s 不再发 ping
    ctx.clock.advance(30000);
    expect(pingCount(ctx.ws())).toBe(1);
  });

  it('resume 探测命中「未知消息类型」时上报 probe=resume', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();

    ctx.transport.send({ t: 'resume', room: 'A8B2', peerId: 'p1', token: 'tk' });
    ctx.ws().message({ t: 'error', message: '未知消息类型' });

    expect(ctx.events).toContainEqual({ type: 'probe-unsupported', probe: 'resume' });
  });

  it('普通错误文案（房间已满）不会触发兼容探测', () => {
    const ctx = setup();
    ctx.transport.connect('ws://localhost:3000/signal', 5000);
    ctx.ws().open();

    ctx.ws().message({ t: 'error', message: '房间已满（仅支持 1v1）' });

    expect(ctx.events.some((e) => e.type === 'probe-unsupported')).toBe(false);
    expect(ctx.events).toContainEqual({
      type: 'msg',
      msg: { t: 'error', message: '房间已满（仅支持 1v1）' },
    });
  });
});
