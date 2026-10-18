import { describe, expect, it } from 'vitest';
import type { Move } from '@webrtc-gomoku/core';

import type { GameMessage } from '../../src/types';
import { DEFAULT_POLICY } from '../../src/reconnect/policy';
import type { ConnectionManager, ConnSideEffect } from '../../src/reconnect/orchestrator';
import { createConnectionManager } from '../../src/reconnect/orchestrator';
import type { ConnectionStatus } from '../../src/reconnect/status';

import { CollectingLogger, FakeClock, FakeP2p, FakeSignal } from './fakes';

interface Ctx {
  clock: FakeClock;
  signal: FakeSignal;
  p2p: FakeP2p;
  logger: CollectingLogger;
  events: ConnSideEffect[];
  statuses: ConnectionStatus[];
  moves: Move[];
  replaced: Move[][];
  gameMessages: GameMessage[];
  manager: ConnectionManager;
}

function setup(): Ctx {
  const clock = new FakeClock();
  const signal = new FakeSignal();
  const p2p = new FakeP2p();
  const logger = new CollectingLogger();
  const events: ConnSideEffect[] = [];
  const statuses: ConnectionStatus[] = [];
  const replaced: Move[][] = [];
  const gameMessages: GameMessage[] = [];
  const moves: Move[] = [];

  const manager = createConnectionManager({
    signal,
    p2p,
    clock,
    random: () => 0.5,
    policy: DEFAULT_POLICY,
    logger,
    signalUrl: 'wss://localhost:3000/signal',
    getLocalMoves: () => moves,
    onMovesReplaced: (next) => {
      replaced.push([...next]);
      moves.splice(0, moves.length, ...next);
    },
    onStatus: (s) => statuses.push(s),
    onEvent: (e) => events.push(e),
    onGameMessage: (m) => gameMessages.push(m),
    isOnline: () => true,
  });

  return { clock, signal, p2p, logger, events, statuses, moves, replaced, gameMessages, manager };
}

/** 房主：建房 → created → peer-joined → DC 打开（进入 CONNECTED） */
function hostConnected(ctx: Ctx): void {
  ctx.manager.createRoom('A8B2');
  ctx.signal.open();
  ctx.signal.server({ t: 'created', room: 'A8B2', peerId: 'p1', token: 'tk1' });
  ctx.signal.server({ t: 'peer-joined', peerId: 'p2', name: '对手' });
  ctx.p2p.openDc();
}

/** 加入方：入房 → joined → 收到 offer → DC 打开（进入 CONNECTED） */
function guestConnected(ctx: Ctx): void {
  ctx.manager.joinRoom('A8B2', '我');
  ctx.signal.open();
  ctx.signal.server({ t: 'joined', room: 'A8B2', peerId: 'p2', token: 'tk1' });
  ctx.signal.server({ t: 'signal', data: { kind: 'offer', sdp: 'v=0' } });
  ctx.p2p.openDc();
}

const sentTypes = (ctx: Ctx): string[] => ctx.signal.sent.map((m) => m.t);

describe('orchestrator · 重连缺陷回归', () => {
  it('首次建房握手失败后自动重试仍发送 create', () => {
    const ctx = setup();
    ctx.manager.createRoom('A8B2', '房主');
    ctx.signal.emit({ type: 'connect-timeout' });

    ctx.clock.advance(500);
    ctx.signal.open();

    expect(ctx.signal.sent).toEqual([{ t: 'create', room: 'A8B2', name: '房主' }]);
  });

  it('首次建房失败后立即重试仍发送 create', () => {
    const ctx = setup();
    ctx.manager.createRoom('A8B2', '房主');
    ctx.signal.drop();

    ctx.manager.retryNow();
    ctx.signal.open();

    expect(ctx.signal.sent).toEqual([{ t: 'create', room: 'A8B2', name: '房主' }]);
  });

  it('首次入房握手失败后的成功确认仍通知业务层初始化房间', () => {
    const ctx = setup();
    ctx.manager.joinRoom('A8B2', '加入方');
    ctx.signal.drop();
    ctx.clock.advance(500);
    ctx.signal.open();

    ctx.signal.server({ t: 'joined', room: 'A8B2', peerId: 'p2', token: 'tk2' });

    expect(ctx.manager.getStatus().state).toBe('ROOM_WAITING');
    expect(ctx.events).toContainEqual({ type: 'room-ready', room: 'A8B2', role: 'guest' });
  });

  it('仅 P2P 断线后通道重开并确认棋谱即可恢复落子', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.p2p.dropDc();
    ctx.clock.advance(0);
    ctx.p2p.openDc();

    ctx.p2p.emit({ type: 'msg', msg: { t: 'sync', moves: [], rev: 1, ack: true } });

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.manager.getStatus().isPlayable).toBe(true);
    expect(ctx.events.filter((e) => e.type === 'restored')).toHaveLength(1);
  });

  it('ICE 恢复复用已打开的 DC 时也发起棋谱对账', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.p2p.emit({ type: 'pc-disconnected-settled' });
    ctx.clock.advance(0);

    ctx.p2p.emit({ type: 'pc-state', state: 'connected' });

    expect(ctx.p2p.sent).toContainEqual({ t: 'sync', moves: [], rev: 1 });
    ctx.p2p.emit({ type: 'msg', msg: { t: 'sync', moves: [], rev: 1, ack: true } });
    ctx.clock.advance(20000);
    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.p2p.rebuildCalls).toHaveLength(0);
  });

  it('落子发现 DC 失效后的探测恢复也能完成对账', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.p2p.dcOpen = false;
    ctx.manager.notifyLocalMove();
    ctx.p2p.openDc();

    ctx.p2p.emit({ type: 'msg', msg: { t: 'sync', moves: [], rev: 1, ack: true } });

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.events.filter((e) => e.type === 'restored')).toHaveLength(1);
  });

  it('空房间等待期间信令重连后继续等待对手', () => {
    const ctx = setup();
    ctx.manager.createRoom('A8B2');
    ctx.signal.open();
    ctx.signal.server({ t: 'created', room: 'A8B2', peerId: 'p1', token: 'tk1' });
    ctx.signal.drop();
    ctx.clock.advance(500);
    ctx.signal.open();

    ctx.signal.server({ t: 'resumed', room: 'A8B2', peerId: 'p1', token: 'tk2' });
    ctx.clock.advance(20000);

    expect(ctx.manager.getStatus().state).toBe('ROOM_WAITING');
    expect(ctx.p2p.restartIceCalls).toBe(0);
    expect(ctx.events.filter((e) => e.type === 'failed')).toHaveLength(0);
  });

  it('房主离线期间有人加入时按恢复确认的在场信息建立直连', () => {
    const ctx = setup();
    ctx.manager.createRoom('A8B2');
    ctx.signal.open();
    ctx.signal.server({ t: 'created', room: 'A8B2', peerId: 'p1', token: 'tk1' });
    ctx.signal.drop();
    ctx.clock.advance(500);
    ctx.signal.open();
    const resumed = { t: 'resumed' as const, room: 'A8B2', peerId: 'p1', token: 'tk2', peerPresent: true };

    ctx.signal.server(resumed);
    ctx.clock.advance(3000);

    expect(ctx.manager.getStatus().state).toBe('P2P_RECOVERING');
    expect(ctx.p2p.restartIceCalls).toBe(1);
  });

  it('重连时确认对手已经离开则清盘并继续等待', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.drop();
    ctx.clock.advance(500);
    ctx.signal.open();
    const resumed = { t: 'resumed' as const, room: 'A8B2', peerId: 'p1', token: 'tk2', peerPresent: false };

    ctx.signal.server(resumed);

    expect(ctx.manager.getStatus().state).toBe('ROOM_WAITING');
    expect(ctx.events).toContainEqual({ type: 'peer-gone' });
  });

  it('P2P 先断再收到对手离线通知时仍等待完整宽限期', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.p2p.dropDc();
    ctx.clock.advance(0);

    ctx.signal.server({ t: 'peer-offline', graceSec: 60 });
    ctx.clock.advance(20000);

    expect(ctx.manager.getStatus().state).toBe('P2P_RECOVERING');
    expect(ctx.manager.getStatus().peerOfflineInMs).toBe(40000);
    expect(ctx.p2p.rebuildCalls).toHaveLength(0);
    expect(ctx.events.filter((e) => e.type === 'failed')).toHaveLength(0);
  });
});

describe('orchestrator · 建连与退避', () => {
  it('建房成功后进入 ROOM_WAITING，对手加入后进入 NEGOTIATING', () => {
    const ctx = setup();

    ctx.manager.createRoom('A8B2');
    ctx.signal.open();
    ctx.signal.server({ t: 'created', room: 'A8B2', peerId: 'p1', token: 'tk1' });

    expect(ctx.manager.getStatus().state).toBe('ROOM_WAITING');
    expect(ctx.manager.getStatus().room).toBe('A8B2');

    ctx.signal.server({ t: 'peer-joined', peerId: 'p2', name: '对手' });

    expect(ctx.manager.getStatus().state).toBe('NEGOTIATING');
    expect(ctx.p2p.attached).toEqual([true]);
  });

  it('WS 断开后按 500ms 退避发起重连，第 1 次 attempt=1', () => {
    const ctx = setup();
    hostConnected(ctx);
    expect(ctx.manager.getStatus().state).toBe('CONNECTED');

    ctx.signal.drop(1006);

    expect(ctx.manager.getStatus().state).toBe('RECONNECTING');
    expect(ctx.manager.getStatus().attempt).toBe(1);
    expect(ctx.signal.connectCalls).toBe(1);

    ctx.clock.advance(500);

    expect(ctx.signal.connectCalls).toBe(2);

    ctx.signal.open();

    expect(sentTypes(ctx)).toContain('resume');
    const retry = ctx.logger.of('conn.retry')[0];
    expect(retry).toEqual({
      ev: 'conn.retry',
      attempt: 1,
      delayMs: 500,
      reason: 'WS_CLOSED',
      urlHost: 'localhost',
    });
  });

  it('6 次重试失败后进入 FAILED 且日志恰为 1 条 conn.fail', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.signal.drop(1006);
    for (let i = 0; i < 6; i++) {
      ctx.clock.advance(1000);
      ctx.signal.drop(1006);
    }

    expect(ctx.manager.getStatus().state).toBe('FAILED');
    expect(ctx.manager.getStatus().reason).toBe('POLICY_EXHAUSTED');
    expect(ctx.logger.of('conn.fail')).toHaveLength(1);
    expect(ctx.events.filter((e) => e.type === 'failed')).toHaveLength(1);
  });

  it('FAILED 后 retryNow 重置 attempt 并立即重连', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.drop(1006);
    for (let i = 0; i < 6; i++) {
      ctx.clock.advance(1000);
      ctx.signal.drop(1006);
    }
    const before = ctx.signal.connectCalls;

    ctx.manager.retryNow();

    expect(ctx.manager.getStatus().state).toBe('SIGNAL_CONNECTING');
    expect(ctx.manager.getStatus().attempt).toBe(0);
    expect(ctx.signal.connectCalls).toBe(before + 1);
  });

  it('隐藏 40s 期间不消耗 attempt，可见后立即重试（不等退避）', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.drop(1006);

    ctx.manager.setPageVisible(false);
    ctx.clock.advance(40000);

    expect(ctx.signal.connectCalls).toBe(1);
    expect(ctx.manager.getStatus().attempt).toBe(1);

    ctx.manager.setPageVisible(true);

    expect(ctx.signal.connectCalls).toBe(2);
    expect(ctx.manager.getStatus().attempt).toBe(1);
  });
});

describe('orchestrator · 旧服务端降级（K8-2）', () => {
  it('resume 返回 UNKNOWN_TYPE 时降级为 join 且不再尝试 resume', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.drop(1006);
    ctx.clock.advance(500);
    ctx.signal.open();
    expect(sentTypes(ctx)).toContain('resume');

    ctx.signal.emit({ type: 'probe-unsupported', probe: 'resume' });

    expect(sentTypes(ctx)).toContain('join');
    expect(ctx.logger.of('conn.compat')).toEqual([{ ev: 'conn.compat', server: 'v1' }]);
    expect(ctx.events.some((e) => e.type === 'degraded-to-v1')).toBe(true);
    expect(ctx.manager.getStatus().compat).toBe('v1');

    // 再次掉线重连：不得再发 resume
    ctx.signal.server({ t: 'joined', room: 'A8B2', peerId: 'p1', token: 'tk2' });
    ctx.signal.drop(1006);
    ctx.clock.advance(1000);
    ctx.signal.open();

    expect(sentTypes(ctx).filter((t) => t === 'resume')).toHaveLength(1);
    expect(sentTypes(ctx).filter((t) => t === 'join').length).toBeGreaterThanOrEqual(2);
  });

  it('服务端 error（房间已满）进入 FAILED 且给出 room-invalid 事件', () => {    const ctx = setup();

    ctx.manager.joinRoom('A8B2', '我');
    ctx.signal.open();
    ctx.signal.server({ t: 'error', message: '房间已满（仅支持 1v1）', code: 'ROOM_FULL' });

    expect(ctx.manager.getStatus().state).toBe('FAILED');
    expect(ctx.manager.getStatus().reason).toBe('SERVER_REJECTED');
    const invalid = ctx.events.find((e) => e.type === 'room-invalid');
    expect(invalid).toBeDefined();
    if (invalid && invalid.type === 'room-invalid') {
      expect(invalid.room).toBe('A8B2');
      expect(invalid.message).toBe('房间已满（仅支持 1v1）');
    }
  });

  it('resume 被服务端拒绝归类 SERVER_RESTART 并保留房间号供重建', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.drop(1006);
    ctx.clock.advance(500);
    ctx.signal.open();

    ctx.signal.server({ t: 'error', message: '房间已失效，请重新加入', code: 'RESUME_REJECTED' });

    expect(ctx.manager.getStatus().state).toBe('FAILED');
    expect(ctx.manager.getStatus().reason).toBe('SERVER_RESTART');
    const invalid = ctx.events.find((e) => e.type === 'room-invalid');
    expect(invalid && invalid.type === 'room-invalid' ? invalid.room : '').toBe('A8B2');
  });
});

describe('orchestrator · 恢复与棋谱对账', () => {
  it('恢复后房主发 sync{moves,rev}，收到 ack 后进 CONNECTED 且 conn.restore.movesSynced 正确', () => {
    const ctx = setup();
    ctx.moves.push({ x: 7, y: 7, c: 1 }, { x: 8, y: 8, c: 2 });
    hostConnected(ctx);
    ctx.p2p.dcOpen = false;

    ctx.signal.drop(1006);
    ctx.clock.advance(500);
    ctx.signal.open();
    ctx.signal.server({ t: 'resumed', room: 'A8B2', peerId: 'p1', token: 'tk2' });

    expect(ctx.manager.getStatus().state).toBe('P2P_RECOVERING');

    ctx.signal.server({ t: 'peer-online' });
    ctx.clock.advance(0);
    expect(ctx.p2p.restartIceCalls).toBe(1);

    ctx.p2p.openDc();

    const syncs = ctx.p2p.sent.filter((m) => m.t === 'sync');
    const sync = syncs[syncs.length - 1];
    expect(sync).toBeDefined();
    if (sync && sync.t === 'sync') {
      expect(sync.moves).toHaveLength(2);
      expect(sync.rev).toBeGreaterThan(0);
      expect(sync.ack).toBeUndefined();
    }
    expect(ctx.manager.getStatus().state).toBe('P2P_RECOVERING');

    const rev = sync && sync.t === 'sync' ? sync.rev ?? 0 : 0;
    ctx.p2p.emit({ type: 'msg', msg: { t: 'sync', moves: [], rev, ack: true } });

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    const restore = ctx.logger.of('conn.restore');
    expect(restore).toHaveLength(1);
    expect(restore[0]).toEqual({
      ev: 'conn.restore',
      attempt: 1,
      totalMs: 500,
      via: 'ice-restart',
      movesSynced: 0,
    });
    expect(ctx.events.filter((e) => e.type === 'restored')).toHaveLength(1);
  });

  it('加入方收到房主 sync 后校验重放、替换本地棋谱并回 ack', () => {
    const ctx = setup();
    guestConnected(ctx);
    expect(ctx.manager.getStatus().state).toBe('CONNECTED');

    ctx.p2p.emit({
      type: 'msg',
      msg: { t: 'sync', moves: [{ x: 7, y: 7, c: 1 }, { x: 8, y: 8, c: 2 }], rev: 3 },
    });

    expect(ctx.moves).toHaveLength(2);
    const ack = ctx.p2p.sent.find((m) => m.t === 'sync');
    expect(ack).toBeDefined();
    if (ack && ack.t === 'sync') {
      expect(ack.ack).toBe(true);
      expect(ack.rev).toBe(3);
      expect(ack.moves).toEqual([]);
    }
    expect(ctx.events.some((e) => e.type === 'sync-applied')).toBe(true);
  });

  it('加入方收到脏棋谱时拒绝采纳并记 conn.sync-reject', () => {
    const ctx = setup();
    ctx.moves.push({ x: 7, y: 7, c: 1 });
    guestConnected(ctx);

    ctx.p2p.emit({
      type: 'msg',
      msg: { t: 'sync', moves: [{ x: 7, y: 7, c: 1 }, { x: 7, y: 7, c: 2 }], rev: 4 },
    });

    expect(ctx.moves).toEqual([{ x: 7, y: 7, c: 1 }]);
    expect(ctx.replaced).toHaveLength(0);
    expect(ctx.logger.of('conn.sync-reject')).toEqual([{ ev: 'conn.sync-reject', rev: 4, at: 1 }]);
  });

  it('DC 心跳（ping）由编排器拦截并回 pong，不转发给业务层', () => {
    const ctx = setup();
    guestConnected(ctx);

    ctx.p2p.emit({ type: 'msg', msg: { t: 'ping', ts: 123 } });

    expect(ctx.gameMessages).toHaveLength(0);
    expect(ctx.p2p.sent.some((m) => m.t === 'pong')).toBe(true);
  });

  it('普通局内消息（落子）原样转发给业务层', () => {
    const ctx = setup();
    guestConnected(ctx);

    ctx.p2p.emit({ type: 'msg', msg: { t: 'move', x: 7, y: 7 } });

    expect(ctx.gameMessages).toEqual([{ t: 'move', x: 7, y: 7 }]);
  });
});

describe('orchestrator · 落子失败可见（R9）', () => {
  it('落子 send 返回 false 时记 DC_NOT_OPEN 并触发一次 P2P 检测', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.p2p.dcOpen = false;

    ctx.manager.notifyLocalMove();

    const fails = ctx.logger.of('conn.fail');
    expect(fails).toHaveLength(1);
    expect(fails[0]?.reason).toBe('DC_NOT_OPEN');
    expect(ctx.p2p.restartIceCalls).toBe(1);

    // 同一 incident 内只检测一次
    ctx.manager.notifyLocalMove();
    expect(ctx.p2p.restartIceCalls).toBe(1);
    expect(ctx.logger.of('conn.fail')).toHaveLength(1);
  });

  it('DC 正常时不产生任何提示（M3 误报基线）', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.manager.notifyLocalMove();

    expect(ctx.logger.of('conn.fail')).toHaveLength(0);
    expect(ctx.p2p.restartIceCalls).toBe(0);
  });
});

describe('orchestrator · 对手状态与主动离开', () => {
  it('对手断线进入宽限只更新倒计时、不离开房间', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.signal.server({ t: 'peer-offline', graceSec: 60 });

    const status = ctx.manager.getStatus();
    expect(status.state).toBe('CONNECTED');
    expect(status.peerOfflineInMs).toBe(60000);
    expect(ctx.events.some((e) => e.type === 'peer-offline')).toBe(true);
  });

  /**
   * 契约变更（QA 缺陷 1 修复，2026-10-17）：宽限到期后不再停在 IDLE「未连接」。
   * 此时本端仍在房间里、socket 也健康，正确语义是「清盘 + 回到房间等待新对手」。
   */
  it('对手宽限超时（peer-left）清盘并回到 ROOM_WAITING 等新对手', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.signal.server({ t: 'peer-left' });

    const status = ctx.manager.getStatus();
    expect(status.state).toBe('ROOM_WAITING');
    expect(status.room).toBe('A8B2');
    expect(status.isPlayable).toBe(false);
    expect(ctx.events.some((e) => e.type === 'peer-gone')).toBe(true);
  });

  it('对手主动 bye 时按 PEER_GONE 处理', () => {
    const ctx = setup();
    guestConnected(ctx);

    ctx.manager.notifyPeerGone();

    expect(ctx.manager.getStatus().state).toBe('IDLE');
    expect(ctx.events.some((e) => e.type === 'peer-gone')).toBe(true);
  });

  it('主动离开回到 IDLE 并关闭信令与 P2P', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.manager.leave();

    expect(ctx.manager.getStatus().state).toBe('IDLE');
    expect(ctx.signal.closeCalls).toBeGreaterThan(0);
    expect(ctx.p2p.dcOpen).toBe(false);
  });

  it('dispose 之后不再处理任何 IO 事件（无定时器泄漏）', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.manager.dispose();
    ctx.signal.drop(1006);
    ctx.clock.advance(60000);

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.clock.pendingTimers).toBe(0);
  });
});

/**
 * 场景 D（PRD §5）：服务端不可用 —— 连接被拒 / 握手超时。
   * 断言重点是「归类正确 + 只消耗 1 次 attempt」，避免一次故障吃掉两次重试额度。
   */
describe('orchestrator · 场景 D：服务端不可用', () => {
  it('握手超时（connect-timeout）归类 WS_TIMEOUT 并继续退避', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.drop(1006);
    ctx.clock.advance(500); // 第 1 次重连已发起
    const connectCalls = ctx.signal.connectCalls;

    ctx.signal.emit({ type: 'connect-timeout' });

    expect(ctx.manager.getStatus().state).toBe('RECONNECTING');
    expect(ctx.manager.getStatus().reason).toBe('WS_TIMEOUT');
    expect(ctx.manager.getStatus().attempt).toBe(2);
    // 退避期间不立即重连（不烧 CPU、不刷服务端）
    expect(ctx.signal.connectCalls).toBe(connectCalls);
  });

  it('socket error 紧跟 close 1006（连接被拒）只消耗 1 次 attempt', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.signal.emit({ type: 'error', detail: 'connect-failed' });
    ctx.signal.drop(1006);

    expect(ctx.manager.getStatus().state).toBe('RECONNECTING');
    expect(ctx.manager.getStatus().attempt).toBe(1);
    expect(ctx.manager.getStatus().reason).toBe('WS_CLOSED');
  });
});

/**
 * 场景 G（PRD §5）：长时间离线 —— 6 次耗尽后必须停在 FAILED，
 * 不再有任何后台定时器偷偷重试（用户必须自己点按钮）。
 */
describe('orchestrator · 场景 G：重试耗尽', () => {
  it('FAILED 之后不再静默重试，且给出「立即重试 / 离开房间」两个入口', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.signal.drop(1006);
    for (let i = 0; i < 6; i++) {
      ctx.clock.advance(1000);
      ctx.signal.drop(1006);
    }
    expect(ctx.manager.getStatus().state).toBe('FAILED');

    const connectCallsAtFail = ctx.signal.connectCalls;
    ctx.clock.advance(120000);

    expect(ctx.signal.connectCalls).toBe(connectCallsAtFail);
    expect(ctx.clock.pendingTimers).toBe(0);

    const status = ctx.manager.getStatus();
    expect(status.canRetryNow).toBe(true);
    expect(status.canLeave).toBe(true);
    expect(status.label).toContain('多次重试失败');
  });
});

/**
 * 场景 I（PRD §5）：双端同时掉线 —— 房主恒为 offerer，加入方只应答，
 * 结构性消除 glare（两侧同时 createOffer）。
 */
describe('orchestrator · 场景 I：双端同时掉线', () => {
  it('只有房主发起 ICE restart，加入方零 ICE restart / 零重建，双方都能回到 CONNECTED', () => {
    const host = setup();
    const guest = setup();
    hostConnected(host);
    guestConnected(guest);

    // 两端同时掉线，且 P2P 也一并失效
    host.p2p.dcOpen = false;
    guest.p2p.dcOpen = false;
    host.signal.drop(1006);
    guest.signal.drop(1006);
    host.clock.advance(500);
    guest.clock.advance(500);

    host.signal.open();
    host.signal.server({ t: 'resumed', room: 'A8B2', peerId: 'p1', token: 'tk2' });
    guest.signal.open();
    guest.signal.server({ t: 'resumed', room: 'A8B2', peerId: 'p2', token: 'tk2' });

    expect(host.manager.getStatus().state).toBe('P2P_RECOVERING');
    expect(guest.manager.getStatus().state).toBe('P2P_RECOVERING');

    // 房主等 peer-online 才发 offer（R11）；加入方永远不主动协商
    host.signal.server({ t: 'peer-online' });
    host.clock.advance(0);

    expect(host.p2p.restartIceCalls).toBe(1);
    expect(guest.p2p.restartIceCalls).toBe(0);
    expect(guest.p2p.rebuildCalls).toHaveLength(0);

    // 房主 DC 重开 → 发 sync；加入方采纳并回 ack；双方收敛到 CONNECTED
    host.p2p.openDc();
    guest.p2p.emit({ type: 'msg', msg: { t: 'sync', moves: [], rev: 1 } });
    host.p2p.emit({ type: 'msg', msg: { t: 'sync', moves: [], rev: 1, ack: true } });

    expect(guest.manager.getStatus().state).toBe('CONNECTED');
    expect(host.manager.getStatus().state).toBe('CONNECTED');
    expect(host.logger.of('conn.restore')).toHaveLength(1);
    expect(guest.logger.of('conn.restore')).toHaveLength(1);
  });
});

/**
 * K3 红线：一次完整的「掉线 → 恢复」只允许出现白名单内的日志事件名。
 */
describe('orchestrator · K3 日志事件名白名单', () => {
  it('单次掉线-恢复全流程产生的事件名全部在 K3 白名单内', () => {
    const allowed = new Set([
      'conn.state',
      'conn.retry',
      'conn.restore',
      'conn.fail',
      'conn.compat',
      'conn.sync-reject',
    ]);
    const ctx = setup();
    ctx.moves.push({ x: 7, y: 7, c: 1 });
    hostConnected(ctx);
    ctx.p2p.dcOpen = false;

    ctx.signal.drop(1006);
    ctx.clock.advance(500);
    ctx.signal.open();
    ctx.signal.server({ t: 'resumed', room: 'A8B2', peerId: 'p1', token: 'tk2' });
    ctx.signal.server({ t: 'peer-online' });
    ctx.clock.advance(0);
    ctx.p2p.openDc();
    ctx.p2p.emit({ type: 'msg', msg: { t: 'sync', moves: [], rev: 1, ack: true } });

    expect(ctx.logger.logs.length).toBeGreaterThan(0);
    for (const e of ctx.logger.logs) {
      expect(allowed.has(e.ev), `出现非白名单日志事件 ${e.ev}`).toBe(true);
    }
  });
});

/* ============================================================================
 * 缺陷 1（阻塞）· 对手宽限期内 P2P 失败不得升级为会话级 FATAL
 * ----------------------------------------------------------------------------
 * 根因在对端离线，不在本机网络。此时：
 * - 不得启动 P2P 恢复阶梯（对端不在，ICE restart 必然失败）
 * - 不得进入 FAILED（否则宽限到期后连 peer-left 都收不下，棋盘永不清盘）
 * - 不得关闭仍然健康的信令 socket（它是对手 resume 回来的唯一通道）
 * ========================================================================== */

describe('orchestrator · 对手宽限期内的 P2P 失败（US-2④ / US-3④ / M5）', () => {
  it('对手宽限中 DC 断开：不启动恢复阶梯，状态停在 CONNECTED 并继续倒计时', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.server({ t: 'peer-offline', graceSec: 60 });
    expect(ctx.manager.getStatus().peerOfflineInMs).toBe(60000);

    ctx.p2p.dropDc();

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.p2p.restartIceCalls).toBe(0);
    expect(ctx.p2p.rebuildCalls).toHaveLength(0);

    ctx.clock.advance(30000);

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.manager.getStatus().peerOfflineInMs).toBe(30000);
  });

  it('对手宽限中 P2P 恢复耗尽也不会出现「对称 NAT」式 FAILED，且不关信令 socket', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.server({ t: 'peer-offline', graceSec: 60 });

    ctx.p2p.dropDc();
    ctx.p2p.emit({ type: 'pc-failed' });
    ctx.p2p.emit({ type: 'pc-disconnected-settled' });
    ctx.clock.advance(60000);

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.events.filter((e) => e.type === 'failed')).toHaveLength(0);
    expect(ctx.logger.of('conn.fail')).toHaveLength(0);
    expect(ctx.signal.closeCalls).toBe(0);
    expect(ctx.signal.readyState).toBe('open');
  });

  it('宽限到期收到 peer-left：清盘副作用 + 回到 ROOM_WAITING 等新对手（不是 FAILED）', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.signal.server({ t: 'peer-offline', graceSec: 60 });
    ctx.p2p.dropDc();
    ctx.clock.advance(60000);

    ctx.signal.server({ t: 'peer-left' });

    const status = ctx.manager.getStatus();
    expect(status.state).toBe('ROOM_WAITING');
    expect(status.room).toBe('A8B2');
    expect(status.peerOfflineInMs).toBeNull();
    expect(status.isPlayable).toBe(false);
    expect(ctx.events).toContainEqual({ type: 'peer-gone' });
    expect(ctx.events.filter((e) => e.type === 'failed')).toHaveLength(0);
  });

  it('对手在线但 ICE 全败：仍然进入 FAILED，但**不**关闭信令 socket', () => {
    const ctx = setup();
    hostConnected(ctx);

    ctx.p2p.dropDc();
    ctx.clock.advance(12000);

    expect(ctx.manager.getStatus().state).toBe('FAILED');
    expect(ctx.manager.getStatus().reason).toBe('ICE_FAILED');
    expect(ctx.signal.closeCalls).toBe(0);
    expect(ctx.signal.readyState).toBe('open');
  });
});

/* ============================================================================
 * 缺陷 2（阻塞）· 换房 / 输错房号必须「确认后提交」
 * ----------------------------------------------------------------------------
 * `joinRoom`/`createRoom` 在服务端确认前不得改写 room、不得关闭现有 p2p、
 * 不得重连 socket；收到 error 时当前对局零变化，只把服务端原文抛给 UI。
 * ========================================================================== */

describe('orchestrator · 换房确认后提交（不打断当前对局）', () => {
  it('对局中输错房号：不重连、不改房间、状态与棋谱零变化', () => {
    const ctx = setup();
    ctx.moves.push({ x: 7, y: 7, c: 1 });
    hostConnected(ctx);
    const connectCallsBefore = ctx.signal.connectCalls;

    ctx.manager.joinRoom('ZZZZ', '我');

    expect(ctx.signal.connectCalls).toBe(connectCallsBefore); // 没有重连
    expect(ctx.signal.closeCalls).toBe(0); // 没有拆掉当前会话
    expect(sentTypes(ctx)).toContain('join');
    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.manager.getStatus().room).toBe('A8B2');
    expect(ctx.moves).toHaveLength(1);
  });

  it('输错房号收到 error：只抛 join-rejected（带服务端原文），当前对局零变化', () => {
    const ctx = setup();
    ctx.moves.push({ x: 7, y: 7, c: 1 });
    hostConnected(ctx);

    ctx.manager.joinRoom('ZZZZ', '我');
    ctx.signal.server({ t: 'error', message: '房间 ZZZZ 不存在', code: 'ROOM_NOT_FOUND' });

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.manager.getStatus().room).toBe('A8B2');
    expect(ctx.events.filter((e) => e.type === 'failed')).toHaveLength(0);
    expect(ctx.events).toContainEqual({ type: 'join-rejected', message: '房间 ZZZZ 不存在' });
    expect(ctx.moves).toHaveLength(1);
  });

  it('换房成功：只有 joined 之后才提交新房间，并抛 room-ready 让 UI 清盘', () => {
    const ctx = setup();
    hostConnected(ctx);
    const readyBefore = ctx.events.filter((e) => e.type === 'room-ready').length;

    ctx.manager.joinRoom('B9C3', '我');
    expect(ctx.manager.getStatus().room).toBe('A8B2');
    expect(ctx.events.filter((e) => e.type === 'room-ready')).toHaveLength(readyBefore);

    ctx.signal.server({ t: 'joined', room: 'B9C3', peerId: 'p1', token: 'tk2' });

    const status = ctx.manager.getStatus();
    expect(status.room).toBe('B9C3');
    expect(status.state).toBe('ROOM_WAITING');
    expect(ctx.events).toContainEqual({ type: 'room-ready', room: 'B9C3', role: 'guest' });
  });

  it('首次建房（IDLE）仍走完整建连流程，并抛 room-ready', () => {
    const ctx = setup();

    ctx.manager.createRoom('A8B2', '房主');
    ctx.signal.open();
    ctx.signal.server({ t: 'created', room: 'A8B2', peerId: 'p1', token: 'tk1' });

    expect(ctx.manager.getStatus().state).toBe('ROOM_WAITING');
    expect(ctx.events).toContainEqual({ type: 'room-ready', room: 'A8B2', role: 'host' });
  });
});

/* ============================================================================
 * 缺陷 3（中）· 加入方在 P2P_RECOVERING 必须有 sync 超时兜底
 * ----------------------------------------------------------------------------
 * 新客户端连旧客户端：对端永远不回 sync ack，加入方不得永久卡在
 * 「网络波动，正在恢复直连…」。3s 超时按「已恢复但未确认」降级放行（§10.3）。
 * ========================================================================== */

describe('orchestrator · 加入方 sync 超时兜底（§10.3）', () => {
  it('加入方 DC 重开但收不到 sync：3s 后降级放行回到 CONNECTED', () => {
    const ctx = setup();
    guestConnected(ctx);

    ctx.p2p.dropDc();
    expect(ctx.manager.getStatus().state).toBe('P2P_RECOVERING');

    ctx.p2p.openDc();
    expect(ctx.manager.getStatus().state).toBe('P2P_RECOVERING');

    ctx.clock.advance(3000);

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: 'restored' }));
  });

  it('加入方收到房主 sync 时按棋谱对齐后立即恢复（不等超时）', () => {
    const ctx = setup();
    guestConnected(ctx);
    ctx.p2p.dropDc();
    ctx.p2p.openDc();

    ctx.p2p.emit({ type: 'msg', msg: { t: 'sync', moves: [{ x: 7, y: 7, c: 1 }], rev: 1 } });

    expect(ctx.manager.getStatus().state).toBe('CONNECTED');
    expect(ctx.moves).toHaveLength(1);
    expect(ctx.p2p.sent).toContainEqual({ t: 'sync', moves: [], rev: 1, ack: true });
  });
});

describe('orchestrator · 恢复语义不得触发清盘（room-ready 边界）', () => {
  it('旧服务端降级 rejoin 收到 joined 时不抛 room-ready，棋谱保留', () => {
    const ctx = setup();
    hostConnected(ctx);
    ctx.moves.push({ x: 7, y: 7, c: 1 });
    const readyBefore = ctx.events.filter((e) => e.type === 'room-ready').length;

    ctx.signal.drop(1006);
    ctx.clock.advance(500);
    ctx.signal.open();
    ctx.signal.emit({ type: 'probe-unsupported', probe: 'resume' });

    ctx.signal.server({ t: 'joined', room: 'A8B2', peerId: 'p1', token: 'tk2' });

    expect(ctx.events.filter((e) => e.type === 'room-ready')).toHaveLength(readyBefore);
    expect(ctx.moves).toHaveLength(1);
  });
});
