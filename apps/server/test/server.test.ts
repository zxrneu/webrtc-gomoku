import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:http', () => ({ default: { createServer: () => ({ listen: vi.fn(), close: vi.fn() }) } }));
vi.mock('ws', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return { WebSocket: { OPEN: 1 }, WebSocketServer: class extends Emitter { clients = new Set(); } };
});

const previousSignals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
const { registry, seats, wss } = await import('../src/server');
for (const [signal, previous] of previousSignals) {
  for (const listener of process.listeners(signal)) {
    if (!previous.includes(listener)) process.removeListener(signal, listener);
  }
}

class Socket extends EventEmitter {
  readyState = 1;
  __id = '';
  messages: Record<string, unknown>[] = [];
  send(raw: string): void { this.messages.push(JSON.parse(raw) as Record<string, unknown>); }
  receive(value: unknown): void { this.emit('message', Buffer.from(JSON.stringify(value))); }
  last(type: string): Record<string, unknown> | undefined { return [...this.messages].reverse().find(m => m.t === type); }
}

const sockets: Socket[] = [];
function connect(): Socket {
  const socket = new Socket(); sockets.push(socket);
  wss.emit('connection', socket, { socket: { remoteAddress: `test-${sockets.length}` } });
  return socket;
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => {
  for (const socket of sockets) {
    socket.receive({ t: 'leave' }); socket.emit('close');
    registry.leave(socket.__id); seats.release(socket.__id);
  }
  sockets.length = 0; vi.restoreAllMocks();
});

describe('信令输入边界', () => {
  it.each(['create', 'join', 'resume'])('%s 拒绝对象房号且不中断消息处理', t => {
    const socket = connect();
    expect(() => socket.receive({ t, room: { toString: null } })).not.toThrow();
    socket.receive({ t: 'ping', ts: 123 });
    expect(socket.last('pong')).toEqual({ t: 'pong', ts: 123 });
    expect(registry.roomOf(socket.__id)).toBeNull();
  });
  it.each(['create', 'join'])('%s 校验昵称后才迁移房间状态', t => {
    const host = connect(); host.receive({ t: 'create', room: 'DEST' });
    const socket = connect(); socket.receive({ t: 'create', room: 'KEEP' });
    expect(() => socket.receive({ t, room: t === 'create' ? 'NEXT' : 'DEST', name: { toString: null } })).not.toThrow();
    expect(registry.roomOf(socket.__id)).toBe('KEEP');
  });
  it.each(['peerId', 'token'])('resume 拒绝对象 %s', field => {
    const socket = connect();
    expect(() => socket.receive({ t: 'resume', room: 'DEST', peerId: 'peer', token: 'token', [field]: { toString: null } })).not.toThrow();
    expect(socket.last('resumed')).toBeUndefined();
  });
  it('ping 拒绝非数字时间戳', () => {
    const socket = connect(); socket.receive({ t: 'ping', ts: { invalid: true } });
    expect(socket.last('pong')).toBeUndefined();
  });
  it('忽略非对象及缺少消息类型的 JSON', () => {
    const socket = connect();
    for (const value of [null, [], 123, 'text', {}, { t: 1 }]) socket.receive(value);
    expect(socket.messages).toEqual([]);
  });
  it('未知消息类型仍返回兼容错误', () => {
    const socket = connect(); socket.receive({ t: 'future-command' });
    expect(socket.last('error')).toEqual({ t: 'error', message: '未知消息类型' });
  });
});

describe('恢复座位的状态约束', () => {
  it('已有房间的连接不能恢复另一身份且保留原座位', () => {
    const original = connect(); original.receive({ t: 'create', room: 'ORIG' });
    const credential = original.last('created')!;
    const replacement = connect(); replacement.receive({ t: 'create', room: 'PREV' });
    const previousId = replacement.__id;
    replacement.receive({ t: 'resume', room: 'ORIG', peerId: credential.peerId, token: credential.token });
    expect(replacement.last('error')).toMatchObject({ code: 'RESUME_REJECTED' });
    expect(replacement.__id).toBe(previousId);
    expect(registry.roomOf(previousId)).toBe('PREV');
    replacement.emit('close');
    expect(seats.peek(previousId)?.offlineSinceMs).toBeTypeOf('number');
  });
  it('未入房连接仍可恢复合法座位', () => {
    const original = connect(); original.receive({ t: 'create', room: 'ORIG' });
    const credential = original.last('created')!;
    original.emit('close');
    const replacement = connect();
    replacement.receive({ t: 'resume', room: 'ORIG', peerId: credential.peerId, token: credential.token });
    expect(replacement.last('resumed')).toMatchObject({ t: 'resumed', room: 'ORIG', peerId: credential.peerId });
    expect(seats.peek(replacement.__id)?.offlineSinceMs).toBeNull();
  });
});

describe('房主离开后的继任角色', () => {
  function pair(): { host: Socket; guest: Socket } {
    const host = connect(); const guest = connect();
    host.receive({ t: 'lobby-enter', name: '旧房主', browserId: 'host-browser', tabId: 'host-tab' });
    guest.receive({ t: 'lobby-enter', name: '新房主', browserId: 'guest-browser', tabId: 'guest-tab' });
    host.receive({ t: 'create', room: 'PROM', name: '旧房主' });
    guest.receive({ t: 'join', room: 'PROM', name: '新房主' });
    return { host, guest };
  }
  it.each(['leave', 'create', 'join', 'expire'])('%s 路径让剩余玩家成为房主', action => {
    const { host, guest } = pair();
    if (action === 'leave') host.receive({ t: 'leave' });
    if (action === 'create') host.receive({ t: 'create', room: 'NEXT' });
    if (action === 'join') {
      const other = connect(); other.receive({ t: 'create', room: 'NEXT' });
      host.receive({ t: 'join', room: 'NEXT' });
    }
    if (action === 'expire') {
      host.emit('close');
      for (const seat of seats.sweep(Date.now() + 60001)) registry.leave(seat.peerId);
    }
    expect(guest.last('peer-left')).toEqual({ t: 'peer-left', role: 'host' });
    expect(seats.peek(guest.__id)?.role).toBe('host');
    guest.receive({ t: 'lobby-list' });
    expect(guest.last('lobby-state')?.room).toMatchObject({ code: 'PROM', role: 'host' });
  });
  it('继任房主恢复座位时返回持久化的房主角色', () => {
    const { host, guest } = pair();
    const credential = guest.last('joined')!;
    host.receive({ t: 'leave' }); guest.emit('close');
    const replacement = connect();
    replacement.receive({ t: 'resume', room: 'PROM', peerId: credential.peerId, token: credential.token });
    expect(replacement.last('resumed')).toMatchObject({ room: 'PROM', role: 'host' });
  });
  it('原房主留下时角色仍为房主', () => {
    const { host, guest } = pair(); guest.receive({ t: 'leave' });
    expect(host.last('peer-left')).toEqual({ t: 'peer-left', role: 'host' });
    expect(seats.peek(host.__id)?.role).toBe('host');
  });
});
