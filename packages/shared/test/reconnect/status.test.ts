import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../../src/reconnect/policy';
import { CONN_STATES, initialSnapshot, type ConnSnapshot, type ConnState } from '../../src/reconnect/state';
import { deriveStatus } from '../../src/reconnect/status';

const P = DEFAULT_POLICY;

function snapshotOf(state: ConnState, patch: Partial<ConnSnapshot> = {}): ConnSnapshot {
  return { ...initialSnapshot(0), state, ...patch };
}

describe('status · isPlayable 穷尽性', () => {
  it('8 个状态中只有 CONNECTED 的 isPlayable 为 true（穷尽期望表）', () => {
    // Record<ConnState, boolean> 保证新增状态忘记归类时编译失败
    const expected: Record<ConnState, boolean> = {
      IDLE: false,
      SIGNAL_CONNECTING: false,
      ROOM_WAITING: false,
      NEGOTIATING: false,
      CONNECTED: true,
      P2P_RECOVERING: false,
      RECONNECTING: false,
      FAILED: false,
    };

    for (const state of CONN_STATES) {
      expect(deriveStatus(snapshotOf(state), P, 0).isPlayable, state).toBe(expected[state]);
    }
  });

  it('isPlayable 不因对手宽限而变为 false（D4 的锁落子在 UI 层合成）', () => {
    const s = snapshotOf('CONNECTED', { peerOfflineUntilMs: 60000 });

    const status = deriveStatus(s, P, 0);

    expect(status.isPlayable).toBe(true);
    expect(status.peerOfflineInMs).toBe(60000);
  });
});

describe('status · 文案（PRD §6.4 逐字）', () => {
  it('IDLE 文案为「未连接」', () => {
    expect(deriveStatus(snapshotOf('IDLE'), P, 0).label).toBe('未连接');
  });

  it('SIGNAL_CONNECTING 首次连接文案为「正在连接服务器…」', () => {
    expect(deriveStatus(snapshotOf('SIGNAL_CONNECTING'), P, 0).label).toBe('正在连接服务器…');
  });

  it('ROOM_WAITING 文案包含房间号与等待提示', () => {
    expect(deriveStatus(snapshotOf('ROOM_WAITING', { room: 'A8B2' }), P, 0).label).toBe(
      '房间 A8B2 · 等待对手加入…'
    );
  });

  it('NEGOTIATING 文案为「对手已加入，正在建立直连…」', () => {
    expect(deriveStatus(snapshotOf('NEGOTIATING'), P, 0).label).toBe('对手已加入，正在建立直连…');
  });

  it('CONNECTED 文案为「已直连」', () => {
    expect(deriveStatus(snapshotOf('CONNECTED'), P, 0).label).toBe('已直连');
  });

  it('P2P_RECOVERING 文案为「网络波动，正在恢复直连…（自动）」', () => {
    expect(deriveStatus(snapshotOf('P2P_RECOVERING'), P, 0).label).toBe('网络波动，正在恢复直连…（自动）');
  });

  it('RECONNECTING 时 label 含「第 2/6 次」与「剩余 8s」', () => {
    const s = snapshotOf('RECONNECTING', { attempt: 2, nextRetryAtMs: 8000 });

    const status = deriveStatus(s, P, 0);

    expect(status.label).toContain('第 2/6 次');
    expect(status.label).toContain('剩余 8s');
  });

  it('FAILED 时 label 含原因文案与「棋盘已保留」', () => {
    const status = deriveStatus(snapshotOf('FAILED', { reason: 'SERVER_RESTART' }), P, 0);

    expect(status.label).toBe('已断开：服务器已重启，房间失效。棋盘已保留。');
  });

  it('FAILED 且无原因时使用兜底文案', () => {
    expect(deriveStatus(snapshotOf('FAILED'), P, 0).label).toBe('已断开：连接失败。棋盘已保留。');
  });
});

describe('status · 倒计时与可操作项', () => {
  it('nextRetryInMs 由 nextRetryAtMs 与当前时刻推导且不为负', () => {
    const s = snapshotOf('RECONNECTING', { nextRetryAtMs: 5000 });

    expect(deriveStatus(s, P, 1000).nextRetryInMs).toBe(4000);
    expect(deriveStatus(s, P, 9000).nextRetryInMs).toBe(0);
  });

  it('非 RECONNECTING 状态的 nextRetryInMs 为 null', () => {
    expect(deriveStatus(snapshotOf('CONNECTED'), P, 0).nextRetryInMs).toBeNull();
  });

  it('FAILED 恒可立即重试，CONNECTED 不可', () => {
    expect(deriveStatus(snapshotOf('FAILED'), P, 0).canRetryNow).toBe(true);
    expect(deriveStatus(snapshotOf('CONNECTED'), P, 0).canRetryNow).toBe(false);
  });

  it('RECONNECTING 且页面可见时可立即重试，页面隐藏时不可', () => {
    const visible = snapshotOf('RECONNECTING', { attempt: 1, paused: false });
    const hidden = snapshotOf('RECONNECTING', { attempt: 1, paused: true });

    expect(deriveStatus(visible, P, 0).canRetryNow).toBe(true);
    expect(deriveStatus(hidden, P, 0).canRetryNow).toBe(false);
  });

  it('IDLE 不可离开房间，其余状态均可', () => {
    expect(deriveStatus(snapshotOf('IDLE'), P, 0).canLeave).toBe(false);
    expect(deriveStatus(snapshotOf('ROOM_WAITING'), P, 0).canLeave).toBe(true);
    expect(deriveStatus(snapshotOf('FAILED'), P, 0).canLeave).toBe(true);
  });

  it('peerOfflineInMs 到期后为 0 而非负数', () => {
    const s = snapshotOf('CONNECTED', { peerOfflineUntilMs: 3000 });

    expect(deriveStatus(s, P, 1000).peerOfflineInMs).toBe(2000);
    expect(deriveStatus(s, P, 5000).peerOfflineInMs).toBe(0);
  });

  it('status 透传 attempt / maxAttempts / role / room / compat', () => {
    const s = snapshotOf('RECONNECTING', {
      attempt: 3,
      role: 'host',
      room: 'A8B2',
      serverCompat: 'v1',
      reason: 'WS_CLOSED',
    });

    const status = deriveStatus(s, P, 0);

    expect(status.attempt).toBe(3);
    expect(status.maxAttempts).toBe(P.maxAttempts);
    expect(status.role).toBe('host');
    expect(status.room).toBe('A8B2');
    expect(status.compat).toBe('v1');
    expect(status.reason).toBe('WS_CLOSED');
  });
});
