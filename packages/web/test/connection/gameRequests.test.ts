import { describe, expect, it, vi } from 'vitest';
import { BLACK, WHITE, applyMove, create } from '@webrtc-gomoku/core';
import type { GameMessage } from '@webrtc-gomoku/shared';
import { createGameRequests } from '../../src/connection/gameRequests';
import type { ModalState } from '../../src/types';

function setup() {
  const gameRef = { current: create() };
  applyMove(gameRef.current, 7, 7, BLACK);
  let modal: ModalState = { open: false, title: '', text: '', onOk() {}, onNo() {} };
  let context = { active: true, session: {}, room: 'ROOM' as string | null };
  const send = vi.fn((_msg: GameMessage) => true);
  const showToast = vi.fn();
  let nextId = 0;
  const requests = createGameRequests(() => ({ gameRef, context, send, showToast, generateId: () => `request-${++nextId}`,
    setGame: game => { gameRef.current = game; }, addSysMsg: () => {}, isBlocked: () => false,
    isModalOpen: () => modal.open,
    setModal: value => { modal = typeof value === 'function' ? value(modal) : value; },
  }));
  const reply = (kind: 'undo' | 'restart', accepted = true) => {
    const request = send.mock.calls.map(([msg]) => msg).filter(msg => msg.t === `${kind}-req`).at(-1);
    requests.handle({ t: `${kind}-${accepted ? 'ok' : 'no'}`, requestId: request && 'requestId' in request ? request.requestId : undefined });
  };
  return { requests, gameRef, send, showToast, reply, modal: () => modal,
    switchSession: () => { context = { ...context, session: {} }; },
    changeMode: () => { context = { ...context, active: !context.active }; },
  };
}

describe('game request agreement', () => {
  it.each(['undo', 'restart'] as const)('allows a new %s after an earlier agreement completes', kind => {
    const t = setup();
    t.requests.request(kind); t.reply(kind);
    applyMove(t.gameRef.current, 8, 8, BLACK);
    t.requests.request(kind); t.reply(kind);
    expect(t.gameRef.current.moves).toHaveLength(0);
    expect(t.send.mock.calls.map(([msg]) => msg.t)).toEqual([`${kind}-req`, `${kind}-req`]);
  });
  it('ignores a different kind of confirmation without consuming the actual request', () => {
    const t = setup();
    t.requests.request('undo'); t.reply('restart');
    expect(t.gameRef.current.moves).toHaveLength(1);
    t.reply('undo');
    expect(t.gameRef.current.moves).toHaveLength(0);
  });
  it('allows a fresh request after invalidation while ignoring its old reply', () => {
    const t = setup();
    t.requests.request('undo'); applyMove(t.gameRef.current, 8, 8, WHITE);
    t.requests.request('undo');
    expect(t.send).toHaveBeenCalledTimes(2);
    t.requests.handle({ t: 'undo-ok', requestId: 'request-1' });
    expect(t.gameRef.current.moves).toHaveLength(2);
    t.reply('undo');
    expect(t.gameRef.current.moves).toHaveLength(1);
  });
  it('rejects an incoming request invalidated by a newer move so the sender can retry', () => {
    const t = setup();
    t.requests.handle({ t: 'undo-req', requestId: 'peer-1' });
    applyMove(t.gameRef.current, 8, 8, WHITE);
    t.requests.reconcile(); t.requests.closeDialog();
    expect(t.modal().open).toBe(false);
    expect(t.send).toHaveBeenCalledWith({ t: 'undo-no', requestId: 'peer-1' });
    expect(t.gameRef.current.moves).toHaveLength(2);
  });
  it('ends an incoming request when switching away from online play', () => {
    const t = setup();
    t.requests.handle({ t: 'restart-req', requestId: 'peer-1' });
    t.changeMode(); t.requests.reconcile(); t.requests.closeDialog();
    expect(t.send).toHaveBeenCalledWith({ t: 'restart-no', requestId: 'peer-1' });
    expect(t.modal().open).toBe(false);
  });
  it('closes an old dialog without dismissing a newer unrelated dialog', () => {
    const t = setup();
    t.requests.handle({ t: 'undo-req', requestId: 'peer-1' });
    const old = t.modal();
    t.requests.invalidate(); t.requests.handle({ t: 'restart-req', requestId: 'peer-1' });
    old.onOk();
    expect(t.modal().open).toBe(true);
    expect(t.modal().title).toContain('重新开始');
    expect(t.gameRef.current.moves).toHaveLength(1);
  });
  it('keeps the original game state immutable when accepting undo', () => {
    const t = setup(); const before = t.gameRef.current;
    t.requests.handle({ t: 'undo-req', requestId: 'peer-1' }); t.modal().onOk();
    expect(before.moves).toHaveLength(1);
    expect(before.board[7]?.[7]).toBe(BLACK);
    expect(t.gameRef.current.moves).toHaveLength(0);
  });
  it('reports request send failure without creating an outstanding agreement', () => {
    const t = setup(); t.send.mockReturnValue(false);
    t.requests.request('restart'); t.reply('restart');
    expect(t.showToast).toHaveBeenCalledWith(expect.stringContaining('申请发送失败'));
    expect(t.gameRef.current.moves).toHaveLength(1);
  });
  it('can retry a request after the peer refuses it', () => {
    const t = setup(); t.requests.request('restart'); t.reply('restart', false);
    t.requests.request('restart'); t.reply('restart');
    expect(t.gameRef.current.moves).toHaveLength(0);
  });
  it('does not apply a completed old confirmation during a new request', () => {
    const t = setup();
    t.requests.request('restart'); t.reply('restart');
    applyMove(t.gameRef.current, 8, 8, BLACK);
    t.requests.request('restart');
    t.requests.handle({ t: 'restart-ok', requestId: 'request-1' });
    expect(t.gameRef.current.moves).toHaveLength(1);
    t.reply('restart');
    expect(t.gameRef.current.moves).toHaveLength(0);
  });
  it('does not consume a request when its confirmation id is wrong or missing', () => {
    const t = setup(); t.requests.request('undo');
    t.requests.handle({ t: 'undo-ok', requestId: 'someone-else' });
    t.requests.handle({ t: 'undo-ok' });
    expect(t.gameRef.current.moves).toHaveLength(1);
    t.reply('undo');
    expect(t.gameRef.current.moves).toHaveLength(0);
  });
  it.each(['undo', 'restart'] as const)('answers a legacy %s request with an explicit refusal', kind => {
    const t = setup(); t.requests.handle({ t: `${kind}-req` });
    expect(t.send).toHaveBeenCalledWith({ t: `${kind}-no` });
    expect(t.modal().open).toBe(false);
    expect(t.gameRef.current.moves).toHaveLength(1);
    expect(t.showToast).toHaveBeenCalledWith(expect.stringContaining('刷新'));
  });

  it('ignores a duplicate incoming request while its original dialog is pending', () => {
    const t = setup();
    t.requests.handle({ t: 'undo-req', requestId: 'peer-1' });
    const dialog = t.modal();
    t.requests.handle({ t: 'undo-req', requestId: 'peer-1' });
    expect(t.modal()).toBe(dialog);
    expect(t.send).not.toHaveBeenCalled();
    dialog.onOk();
    expect(t.send).toHaveBeenCalledWith({ t: 'undo-ok', requestId: 'peer-1' });
    expect(t.gameRef.current.moves).toHaveLength(0);
  });
  it('replies to an already accepted request without applying it to a new board', () => {
    const t = setup();
    t.requests.handle({ t: 'restart-req', requestId: 'peer-1' }); t.modal().onOk();
    applyMove(t.gameRef.current, 8, 8, BLACK);
    t.requests.handle({ t: 'restart-req', requestId: 'peer-1' });
    expect(t.gameRef.current.moves).toHaveLength(1);
    expect(t.modal().open).toBe(false);
    expect(t.send).toHaveBeenLastCalledWith({ t: 'restart-ok', requestId: 'peer-1' });
  });
  it('does not let an old incoming dialog affect a newly connected opponent', () => {
    const t = setup();
    t.requests.handle({ t: 'restart-req', requestId: 'peer-1' });
    const dialog = t.modal();
    t.switchSession(); t.requests.reconcile();
    dialog.onOk();
    expect(t.gameRef.current.moves).toHaveLength(1);
    expect(t.send).not.toHaveBeenCalled();
  });

});
