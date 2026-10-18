import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../../src/reconnect/policy';
import {
  CONN_STATES,
  initialSnapshot,
  reduce,
  type ConnEvent,
  type ConnSnapshot,
  type ConnState,
} from '../../src/reconnect/state';

const P = DEFAULT_POLICY;

/** 从 IDLE 走到 CONNECTED 的快照，供各用例复用 */
function connectedSnapshot(): ConnSnapshot {
  let s = initialSnapshot(0);
  s = reduce(s, { type: 'START', at: 0, role: 'host', room: 'A8B2' }, P);
  s = reduce(s, { type: 'ROOM_READY', at: 10, room: 'A8B2' }, P);
  s = reduce(s, { type: 'PEER_PRESENT', at: 20 }, P);
  s = reduce(s, { type: 'DC_OPEN', at: 30 }, P);
  return s;
}

function at(state: ConnSnapshot['state']): ConnSnapshot {
  return { ...initialSnapshot(0), state };
}

describe('state · 状态枚举', () => {
  it('CONN_STATES 恰好是 K1 规定的 8 个字面量且顺序一致', () => {
    expect(CONN_STATES).toEqual([
      'IDLE',
      'SIGNAL_CONNECTING',
      'ROOM_WAITING',
      'NEGOTIATING',
      'CONNECTED',
      'P2P_RECOVERING',
      'RECONNECTING',
      'FAILED',
    ]);
  });

  it('initialSnapshot 的初始值为 IDLE / attempt=0 / 无原因', () => {
    const s = initialSnapshot(1234);

    expect(s.state).toBe('IDLE');
    expect(s.attempt).toBe(0);
    expect(s.p2pAttempt).toBe(0);
    expect(s.reason).toBeNull();
    expect(s.nextRetryAtMs).toBeNull();
    expect(s.since).toBe(1234);
    expect(s.paused).toBe(false);
    expect(s.serverCompat).toBe('v1.1');
  });
});

describe('state · 合法迁移', () => {
  it('IDLE 收到 START 迁移到 SIGNAL_CONNECTING 并写入角色与房间', () => {
    const next = reduce(initialSnapshot(0), { type: 'START', at: 5, role: 'guest', room: 'A8B2' }, P);

    expect(next.state).toBe('SIGNAL_CONNECTING');
    expect(next.role).toBe('guest');
    expect(next.room).toBe('A8B2');
    expect(next.attempt).toBe(0);
    expect(next.since).toBe(5);
  });

  it('SIGNAL_CONNECTING 收到 ROOM_READY 迁移到 ROOM_WAITING', () => {
    const s = reduce(initialSnapshot(0), { type: 'START', at: 0, role: 'host', room: 'A8B2' }, P);
    const next = reduce(s, { type: 'ROOM_READY', at: 9, room: 'A8B2' }, P);

    expect(next.state).toBe('ROOM_WAITING');
    expect(next.room).toBe('A8B2');
  });

  it('SIGNAL_OPEN 只代表 socket 打开，不产生状态迁移', () => {
    const s = reduce(initialSnapshot(0), { type: 'START', at: 0, role: 'host', room: 'A8B2' }, P);
    const next = reduce(s, { type: 'SIGNAL_OPEN', at: 3 }, P);

    expect(next).toBe(s);
  });

  it('ROOM_WAITING 收到 PEER_PRESENT 迁移到 NEGOTIATING', () => {
    const s = reduce(connectedSnapshot(), { type: 'SIGNAL_LOST', at: 100, reason: 'WS_CLOSED' }, P);
    const ready = reduce(s, { type: 'RETRY_DUE', at: 600 }, P);
    const waiting = reduce(ready, { type: 'ROOM_READY', at: 700, room: 'A8B2' }, P);

    const next = reduce(waiting, { type: 'PEER_PRESENT', at: 800 }, P);

    expect(waiting.state).toBe('ROOM_WAITING');
    expect(next.state).toBe('NEGOTIATING');
  });

  it('CONNECTED 收到 SIGNAL_LOST 迁移到 RECONNECTING 且 attempt=1', () => {
    const next = reduce(connectedSnapshot(), { type: 'SIGNAL_LOST', at: 100, reason: 'WS_CLOSED' }, P);

    expect(next.state).toBe('RECONNECTING');
    expect(next.attempt).toBe(1);
    expect(next.reason).toBe('WS_CLOSED');
    expect(next.lastFailAtMs).toBe(100);
  });

  it('CONNECTED 收到 P2P_LOST 迁移到 P2P_RECOVERING 且 p2pAttempt=1', () => {
    const next = reduce(connectedSnapshot(), { type: 'P2P_LOST', at: 100, reason: 'ICE_FAILED' }, P);

    expect(next.state).toBe('P2P_RECOVERING');
    expect(next.p2pAttempt).toBe(1);
  });

  it('P2P_RECOVERING 收到 SYNCED 迁移到 CONNECTED 并写入 movesSynced', () => {
    const recovering = reduce(connectedSnapshot(), { type: 'P2P_LOST', at: 100, reason: 'ICE_FAILED' }, P);
    const next = reduce(recovering, { type: 'SYNCED', at: 300, movesSynced: 2 }, P);

    expect(next.state).toBe('CONNECTED');
    expect(next.movesSynced).toBe(2);
    expect(next.p2pAttempt).toBe(0);
  });

  it('RECONNECTING 收到 RETRY_DUE 迁移到 SIGNAL_CONNECTING 并清空倒计时', () => {
    const recovering = reduce(connectedSnapshot(), { type: 'SIGNAL_LOST', at: 100, reason: 'WS_CLOSED' }, P);
    const next = reduce(recovering, { type: 'RETRY_DUE', at: 600 }, P);

    expect(next.state).toBe('SIGNAL_CONNECTING');
    expect(next.nextRetryAtMs).toBeNull();
  });

  it('FAILED 收到 RETRY_NOW 迁移到 SIGNAL_CONNECTING 且 attempt 归零', () => {
    const lost = reduce(connectedSnapshot(), { type: 'SIGNAL_LOST', at: 100, reason: 'WS_CLOSED' }, P);
    const due = reduce(lost, { type: 'RETRY_DUE', at: 600 }, P);
    const failed = reduce(due, { type: 'FATAL', at: 700, reason: 'POLICY_EXHAUSTED' }, P);
    const next = reduce(failed, { type: 'RETRY_NOW', at: 800 }, P);

    expect(failed.state).toBe('FAILED');
    expect(next.state).toBe('SIGNAL_CONNECTING');
    expect(next.attempt).toBe(0);
    expect(next.reason).toBeNull();
  });

  it('任意状态收到 LEAVE 都回到 IDLE 并清空计数与原因', () => {
    const next = reduce(connectedSnapshot(), { type: 'LEAVE', at: 500 }, P);

    expect(next.state).toBe('IDLE');
    expect(next.attempt).toBe(0);
    expect(next.p2pAttempt).toBe(0);
    expect(next.reason).toBeNull();
    expect(next.room).toBeNull();
  });

  it('CONNECTED 收到 PEER_OFFLINE 只写宽限到期时刻、不改变状态', () => {
    const s = connectedSnapshot();
    const next = reduce(s, { type: 'PEER_OFFLINE', at: 1000, graceSecs: 60 }, P);

    expect(next.state).toBe('CONNECTED');
    expect(next.peerOfflineUntilMs).toBe(61000);
  });

  it('CONNECTED 收到 INCIDENT_CLOSED 清零 attempt 与 reason', () => {
    const s = { ...connectedSnapshot(), attempt: 3, reason: 'WS_CLOSED' as const };
    const next = reduce(s, { type: 'INCIDENT_CLOSED', at: 900 }, P);

    expect(next.attempt).toBe(0);
    expect(next.reason).toBeNull();
    expect(next.lastFailAtMs).toBe(0);
  });

  it('P2P 恢复中也接受迟到的对手离线通知并记录宽限期', () => {
    const s = reduce(connectedSnapshot(), { type: 'P2P_LOST', at: 500, reason: 'ICE_FAILED' }, P);

    const next = reduce(s, { type: 'PEER_OFFLINE', at: 1000, graceSecs: 60 }, P);

    expect(next.state).toBe('P2P_RECOVERING');
    expect(next.peerOfflineUntilMs).toBe(61000);
  });
});

describe('state · 防抖（R2）', () => {
  it('1s 内连续两次 SIGNAL_LOST 只消耗 1 次 attempt', () => {
    const first = reduce(connectedSnapshot(), { type: 'SIGNAL_LOST', at: 1000, reason: 'WS_CLOSED' }, P);
    const second = reduce(first, { type: 'SIGNAL_LOST', at: 1500, reason: 'WS_CLOSED' }, P);

    expect(first.attempt).toBe(1);
    expect(second).toBe(first);
    expect(second.attempt).toBe(1);
  });

  it('超过 debounceMs 后的第二次 SIGNAL_LOST 正常累加 attempt', () => {
    const first = reduce(connectedSnapshot(), { type: 'SIGNAL_LOST', at: 1000, reason: 'WS_CLOSED' }, P);
    const second = reduce(first, { type: 'SIGNAL_LOST', at: 2000, reason: 'WS_CLOSED' }, P);

    expect(second.attempt).toBe(2);
  });
});

describe('state · 非法迁移被拒绝并返回同一引用', () => {
  it('FAILED 收到 DC_OPEN 返回同一引用（FAILED → CONNECTED 被禁止）', () => {
    const s = at('FAILED');

    expect(reduce(s, { type: 'DC_OPEN', at: 10 }, P)).toBe(s);
  });

  it('IDLE 收到 DC_OPEN 返回同一引用（IDLE → CONNECTED 被禁止）', () => {
    const s = at('IDLE');

    expect(reduce(s, { type: 'DC_OPEN', at: 10 }, P)).toBe(s);
  });

  it('CONNECTED 收到 ROOM_READY 返回同一引用（CONNECTED → ROOM_WAITING 被禁止）', () => {
    const s = connectedSnapshot();

    expect(reduce(s, { type: 'ROOM_READY', at: 10, room: 'A8B2' }, P)).toBe(s);
  });

  it('RECONNECTING 收到 PEER_PRESENT 返回同一引用（必须先经 SIGNAL_CONNECTING）', () => {
    const s = at('RECONNECTING');

    expect(reduce(s, { type: 'PEER_PRESENT', at: 10 }, P)).toBe(s);
  });

  it('IDLE 收到 RETRY_DUE 返回同一引用', () => {
    const s = at('IDLE');

    expect(reduce(s, { type: 'RETRY_DUE', at: 10 }, P)).toBe(s);
  });

  it('FAILED 收到 SIGNAL_LOST 返回同一引用（终态不再消耗 attempt）', () => {
    const s = at('FAILED');

    expect(reduce(s, { type: 'SIGNAL_LOST', at: 10, reason: 'WS_CLOSED' }, P)).toBe(s);
  });

  it('除白名单外的每个「状态 × 事件」组合都被拒绝并返回同一引用', () => {
    // 白名单：允许产生新快照的（状态, 事件）组合；
    // PAUSE/RESUME 是修饰符、SERVER_COMPAT 是会话元数据，二者可作用于任意状态
    const modifier: readonly ConnEvent['type'][] = ['PAUSE', 'RESUME', 'SERVER_COMPAT'];
    const allowed: Record<ConnState, readonly ConnEvent['type'][]> = {
      IDLE: ['START', 'LEAVE', ...modifier],
      SIGNAL_CONNECTING: ['ROOM_READY', 'SIGNAL_LOST', 'FATAL', 'LEAVE', 'SERVER_COMPAT', ...modifier],
      ROOM_WAITING: ['PEER_PRESENT', 'SIGNAL_LOST', 'PEER_GONE', 'LEAVE', 'SERVER_COMPAT', ...modifier],
      NEGOTIATING: ['DC_OPEN', 'P2P_LOST', 'SIGNAL_LOST', 'LEAVE', 'PEER_GONE', 'SERVER_COMPAT', ...modifier],
      CONNECTED: ['P2P_LOST', 'SIGNAL_LOST', 'PEER_OFFLINE', 'INCIDENT_CLOSED', 'LEAVE', 'PEER_GONE', 'SERVER_COMPAT', ...modifier],
      P2P_RECOVERING: ['DC_OPEN', 'SYNCED', 'P2P_LOST', 'PEER_OFFLINE', 'SIGNAL_LOST', 'P2P_EXHAUSTED', 'FATAL', 'LEAVE', 'PEER_GONE', ...modifier],
      RECONNECTING: ['RETRY_DUE', 'RETRY_NOW', 'SIGNAL_LOST', 'FATAL', 'LEAVE', 'PEER_GONE', 'SERVER_COMPAT', ...modifier],
      FAILED: ['RETRY_NOW', 'LEAVE', ...modifier],
    };
    const samples: Record<ConnEvent['type'], ConnEvent> = {
      START: { type: 'START', at: 10, role: 'host', room: 'A8B2' },
      SIGNAL_LOST: { type: 'SIGNAL_LOST', at: 10, reason: 'WS_CLOSED' },
      SIGNAL_OPEN: { type: 'SIGNAL_OPEN', at: 10 },
      ROOM_READY: { type: 'ROOM_READY', at: 10, room: 'A8B2' },
      PEER_PRESENT: { type: 'PEER_PRESENT', at: 10 },
      PEER_OFFLINE: { type: 'PEER_OFFLINE', at: 10, graceSecs: 60 },
      DC_OPEN: { type: 'DC_OPEN', at: 10 },
      P2P_LOST: { type: 'P2P_LOST', at: 10, reason: 'ICE_FAILED' },
      RETRY_DUE: { type: 'RETRY_DUE', at: 10 },
      RETRY_NOW: { type: 'RETRY_NOW', at: 10 },
      P2P_EXHAUSTED: { type: 'P2P_EXHAUSTED', at: 10 },
      FATAL: { type: 'FATAL', at: 10, reason: 'SERVER_REJECTED' },
      PAUSE: { type: 'PAUSE', at: 10 },
      RESUME: { type: 'RESUME', at: 10 },
      INCIDENT_CLOSED: { type: 'INCIDENT_CLOSED', at: 10 },
      SYNCED: { type: 'SYNCED', at: 10, movesSynced: 1 },
      SERVER_COMPAT: { type: 'SERVER_COMPAT', at: 10, compat: 'v1' },
      PEER_GONE: { type: 'PEER_GONE', at: 10 },
      LEAVE: { type: 'LEAVE', at: 10 },
    };

    for (const state of CONN_STATES) {
      for (const [eventType, event] of Object.entries(samples)) {
        const s = { ...at(state), paused: false };
        const next = reduce(s, event, P);
        const isAllowed = (allowed[state] ?? []).includes(event.type);
        // SIGNAL_OPEN 恒为「无迁移」；PAUSE/RESUME 在已处于目标值时也无迁移
        if (isAllowed) continue;
        expect(next, `${state} + ${eventType} 应被拒绝`).toBe(s);
      }
    }
  });

  it('paused 时 RETRY_DUE 被拒绝，RESUME 后 RETRY_NOW 可放行', () => {
    const recovering = reduce(connectedSnapshot(), { type: 'SIGNAL_LOST', at: 100, reason: 'WS_CLOSED' }, P);
    const paused = reduce(recovering, { type: 'PAUSE', at: 150 }, P);
    const blocked = reduce(paused, { type: 'RETRY_DUE', at: 600 }, P);
    const resumed = reduce(paused, { type: 'RESUME', at: 700 }, P);
    const released = reduce(resumed, { type: 'RETRY_NOW', at: 700 }, P);

    expect(paused.paused).toBe(true);
    expect(blocked).toBe(paused);
    expect(blocked.state).toBe('RECONNECTING');
    expect(resumed.paused).toBe(false);
    expect(released.state).toBe('SIGNAL_CONNECTING');
  });

  it('PAUSE / RESUME 只翻转修饰符，不改变状态', () => {
    const s = connectedSnapshot();
    const paused = reduce(s, { type: 'PAUSE', at: 40 }, P);
    const resumed = reduce(paused, { type: 'RESUME', at: 50 }, P);

    expect(paused.state).toBe('CONNECTED');
    expect(paused.paused).toBe(true);
    expect(resumed.state).toBe('CONNECTED');
    expect(resumed.paused).toBe(false);
  });
});

describe('state · 服务端兼容标记', () => {
  it('SERVER_COMPAT 只写 compat 字段，不改变状态', () => {
    const s = connectedSnapshot();
    const next = reduce(s, { type: 'SERVER_COMPAT', at: 100, compat: 'v1' }, P);

    expect(next.state).toBe('CONNECTED');
    expect(next.serverCompat).toBe('v1');
  });

  it('SERVER_COMPAT 重复写入同值返回同一引用', () => {
    const s = { ...connectedSnapshot(), serverCompat: 'v1' as const };

    expect(reduce(s, { type: 'SERVER_COMPAT', at: 100, compat: 'v1' }, P)).toBe(s);
  });
});
