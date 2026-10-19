import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, createConnectionManager, type LobbyState } from '@webrtc-gomoku/shared';
import { createLobbyRuntime } from '../../src/lobby/runtime';
import { CollectingLogger, FakeClock, FakeP2p, FakeSignal } from '../../../shared/test/reconnect/fakes';

function setup() {
  const raw = new FakeSignal(); const clock = new FakeClock(); const p2p = new FakeP2p();
  const runtime = createLobbyRuntime({ clock, name: '小明', browserId: 'browser', tabId: 'tab', url: 'ws://test/signal' });
  const signal = runtime.attach(raw);
  const manager = createConnectionManager({ signal, p2p, clock, policy: DEFAULT_POLICY, random: () => .5,
    logger: new CollectingLogger(), signalUrl: 'ws://test/signal', getLocalMoves: () => [], onMovesReplaced: () => {},
    onStatus: () => {}, onEvent: () => {}, onGameMessage: () => {}, isOnline: () => true });
  runtime.ready(manager); runtime.enable(true); raw.open();
  const state: LobbyState = { t: 'lobby-state', selfId: 'public-a', name: '小明', online: 1, waiting: 0,
    users: [{ id: 'public-a', name: '小明', status: 'idle' }], totalUsers: 1, rooms: [], totalRooms: 0,
    invite: null, match: null, room: null, serverNow: 0, revision: 1 };
  raw.server(state);
  return { raw, clock, p2p, runtime, manager, state };
}

describe('大厅与现有连接编排接线', () => {
  it('忙碌状态同步不被未完成的操作请求拦截', () => {
    const t = setup(); t.runtime.send({ t: 'lobby-name', name: '改名' });
    expect(t.runtime.send({ t: 'lobby-ready', ready: true })).toBe(true);
    expect(t.raw.sent).toContainEqual({ t: 'lobby-ready', ready: true });
    expect(t.runtime.getSnapshot().pending).toBe(true);
  });
  it('空闲进入大厅登记但不改变棋局状态', () => {
    const t = setup(); expect(t.manager.getStatus().state).toBe('IDLE');
    expect(t.raw.sent).toContainEqual({ t: 'lobby-enter', name: '小明', browserId: 'browser', tabId: 'tab' });
    expect(t.runtime.getSnapshot().phase).toBe('ready');
  });
  it('匹配请求防连点，收到状态后才允许下一步', () => {
    const t = setup();
    expect(t.runtime.send({ t: 'lobby-match', action: 'join' })).toBe(true);
    expect(t.runtime.send({ t: 'lobby-match', action: 'join' })).toBe(false);
    expect(t.raw.sent.filter(m => m.t === 'lobby-match')).toHaveLength(1);
  });
  it('使用服务端分配的房间和凭证启动房主，不重连或重复创建房间', () => {
    const t = setup(); const before = t.raw.connectCalls;
    t.raw.server({ t: 'lobby-seat', room: 'A1B2', role: 'host', peerId: 'private-a', token: 'secret' });
    expect(t.manager.getStatus()).toMatchObject({ state: 'ROOM_WAITING', room: 'A1B2' });
    expect(t.raw.connectCalls).toBe(before);
    expect(t.raw.sent.filter(m => m.t === 'create' || m.t === 'join')).toHaveLength(0);
    t.raw.server({ t: 'peer-joined', peerId: 'private-b', name: '小红' });
    expect(t.p2p.attached).toEqual([true]);
  });
  it('加入者只等待 offer，不抢房主角色', () => {
    const t = setup();
    t.raw.server({ t: 'lobby-seat', room: 'A1B2', role: 'guest', peerId: 'b', token: 'secret' });
    expect(t.manager.getStatus().state).toBe('ROOM_WAITING');
    expect(t.p2p.attached).toEqual([]);
    t.raw.server({ t: 'signal', data: { kind: 'offer', sdp: 'v=0' } });
    expect(t.p2p.applied).toHaveLength(1);
  });
  it('取消意图遇到迟到配对会释放座位，不强拉用户进入棋盘', () => {
    const t = setup(); t.raw.server({ ...t.state, match: { since: 0, expiresAt: 60000 } });
    t.runtime.send({ t: 'lobby-match', action: 'leave' });
    t.raw.server({ t: 'lobby-seat', room: 'A1B2', role: 'host', peerId: 'a', token: 'secret' });
    expect(t.raw.sent).toContainEqual({ t: 'leave' });
    expect(t.manager.getStatus().state).toBe('IDLE');
  });
  it('非法服务端快照被丢弃，旧快照不能回滚状态', () => {
    const t = setup(); t.raw.server({ ...t.state, online: -1 });
    expect(t.runtime.getSnapshot().state?.online).toBe(1);
    t.raw.server({ ...t.state, online: 4, revision: 5 });
    t.raw.server({ ...t.state, revision: 2 });
    expect(t.runtime.getSnapshot().state?.online).toBe(4);
  });
  it('离开房间保留大厅连接，仍可再次匹配', () => {
    const t = setup(); t.raw.server({ t: 'lobby-seat', room: 'A1B2', role: 'host', peerId: 'a', token: 'secret' });
    t.manager.leave(); expect(t.raw.readyState).toBe('open');
    expect(t.runtime.getSnapshot().notice).toBe('');
    expect(t.runtime.send({ t: 'lobby-match', action: 'join' })).toBe(true);
  });
  it('空闲时断线自动重连，并清除过期邀请和匹配展示', () => {
    const t = setup(); t.raw.drop();
    expect(t.runtime.getSnapshot().phase).toBe('offline');
    t.clock.advance(2000); expect(t.raw.connectCalls).toBe(2);
    t.raw.open(); t.raw.server({ ...t.state, revision: 4 });
    expect(t.runtime.getSnapshot().notice).toBe('');
  });
  it('半开连接即使仍标记 open 也会创建新连接', () => {
    const t = setup(); t.raw.emit({ type: 'heartbeat-dead' });
    expect(t.raw.readyState).toBe('open');
    t.clock.advance(2000); expect(t.raw.connectCalls).toBe(2);
  });
  it('不支持大厅时不发大厅消息，并允许原来的房间流程', () => {
    const t = setup(); t.runtime.enable(false); const count = t.raw.sent.length;
    expect(t.runtime.send({ t: 'lobby-create', public: true })).toBe(false);
    expect(t.raw.sent).toHaveLength(count);
    expect(t.runtime.getSnapshot().phase).toBe('unsupported');
    t.manager.createRoom('NEXT', '小明'); expect(t.raw.sent).toContainEqual({ t: 'create', room: 'NEXT', name: '小明' });
  });
  it('进入大厅被服务端拒绝时显示可重试状态', () => {
    const t = setup(); t.runtime.enable(true);
    t.raw.server({ t: 'lobby-notice', code: 'SESSION_LIMIT', message: '同一浏览器最多 2 桌' });
    expect(t.runtime.getSnapshot().phase).toBe('offline');
    expect(t.runtime.getSnapshot().notice).toContain('最多');
  });
  it('无响应请求会恢复按钮并显示错误，不能无限等待', () => {
    const t = setup(); t.runtime.send({ t: 'lobby-invite', target: 'public-b' });
    t.clock.advance(8000); expect(t.runtime.getSnapshot().pending).toBe(false);
    expect(t.runtime.getSnapshot().notice).toContain('超时');
  });
  it('页面释放后编排器清理不会清除刷新凭证', () => {
    const raw = new FakeSignal(); const clock = new FakeClock(); const changes: unknown[] = [];
    const runtime = createLobbyRuntime({ clock, name: '小明', browserId: 'b', tabId: 't', url: 'ws://test', onSeat: s => changes.push(s) });
    const signal = runtime.attach(raw); runtime.dispose(); signal.close();
    expect(changes).toEqual([]);
  });
  it('释放时关闭底层连接并清理所有定时器', () => {
    const t = setup(); t.raw.drop(); t.runtime.dispose(); t.clock.advance(10000);
    expect(t.raw.readyState).toBe('closed'); expect(t.raw.connectCalls).toBe(1);
  });
});

describe('刷新后恢复服务端座位', () => {
  it('凭证经服务端校验后才恢复原房主角色，不重复建房', () => {
    const raw = new FakeSignal(); const clock = new FakeClock(); const p2p = new FakeP2p();
    const runtime = createLobbyRuntime({ clock, name: '小明', browserId: 'browser', tabId: 'tab', url: 'ws://test/signal',
      restoreSeat: { t: 'lobby-seat', room: 'A1B2', role: 'host', peerId: 'private-a', token: 'secret' } });
    const signal = runtime.attach(raw);
    const manager = createConnectionManager({ signal, p2p, clock, policy: DEFAULT_POLICY, random: () => .5,
      logger: new CollectingLogger(), signalUrl: 'ws://test/signal', getLocalMoves: () => [], onMovesReplaced: () => {},
      onStatus: () => {}, onEvent: () => {}, onGameMessage: () => {}, isOnline: () => true });
    runtime.ready(manager); runtime.enable(true); raw.open();
    expect(raw.sent).toContainEqual({ t: 'resume', room: 'A1B2', peerId: 'private-a', token: 'secret' });
    expect(manager.getStatus().state).toBe('IDLE');
    raw.server({ t: 'resumed', room: 'A1B2', peerId: 'private-a', token: 'rotated', peerPresent: true });
    expect(manager.getStatus().room).toBe('A1B2'); expect(p2p.attached).toEqual([true]);
    expect(raw.sent.filter(m => m.t === 'create')).toHaveLength(0);
  });
});
