import { describe, it, expect } from 'vitest';

import { BLACK, EMPTY, applyMove } from '@webrtc-gomoku/core';

import { closedModal, createRoomSession } from '../src/roomSession';

/**
 * 房间会话：每次「创建房间 / 加入房间 / 对手离开」都必须拿到一份全新的初始状态。
 * 本组用例锁死「上一房间数据不得残留到下一房间」这一契约。
 */
describe('roomSession.createRoomSession', () => {
  it('新房间棋盘为空：无手数、无胜负、无连线', () => {
    const s = createRoomSession();

    expect(s.game.moves).toEqual([]);
    expect(s.game.over).toBe(false);
    expect(s.game.winLine).toBeNull();
    expect(s.game.board.every((row) => row.every((c) => c === EMPTY))).toBe(true);
  });

  it('新房间不残留上一局的落子（棋盘是全新可变对象，不是共享常量）', () => {
    const previous = createRoomSession();
    // core.applyMove 原地修改棋盘，模拟上一房间已经下过的棋
    expect(applyMove(previous.game, 7, 7, BLACK).ok).toBe(true);
    expect(previous.game.moves).toHaveLength(1);

    const next = createRoomSession();

    expect(next.game.moves).toHaveLength(0);
    expect(next.game.board[7]![7]).toBe(EMPTY);
  });

  it('新房间不残留上一局的聊天记录', () => {
    expect(createRoomSession().messages).toEqual([]);
  });

  it('新房间不残留对手昵称、传输信息与连接状态', () => {
    const s = createRoomSession();

    expect(s.peerName).toBe('');
    expect(s.connected).toBe(false);
    expect(s.transport).toBeNull();
  });

  it('新房间清空房间状态与手动邀请码流程', () => {
    const s = createRoomSession();

    expect(s.roomStatus).toBe('');
    expect(s.flow).toBe('idle');
    expect(s.hostOfferCode).toBe('');
    expect(s.guestOfferInput).toBe('');
    expect(s.hostAnswerInput).toBe('');
    expect(s.guestAnswerCode).toBe('');
    expect(s.hostTimer).toBe('0:00');
    expect(s.flowResult).toBeNull();
  });

  it('新房间关闭上一房间遗留的确认弹窗（避免旧房主的悔棋/重开请求泄漏）', () => {
    const s = createRoomSession();

    expect(s.modal.open).toBe(false);
    expect(s.modal.title).toBe('');
    expect(s.modal.text).toBe('');
    expect(typeof s.modal.onOk).toBe('function');
    expect(typeof s.modal.onNo).toBe('function');
  });
});

describe('roomSession.closedModal', () => {
  it('返回的弹窗状态为关闭，且回调可安全调用（不抛错）', () => {
    const modal = closedModal();

    expect(modal.open).toBe(false);
    expect(() => {
      modal.onOk();
      modal.onNo();
    }).not.toThrow();
  });
});
