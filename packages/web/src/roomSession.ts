/**
 * 房间会话状态（room-scoped state）
 *
 * 单一职责：定义「一个房间会话」的全部初始值，并保证每次调用都返回一份全新的棋盘。
 *
 * 为什么需要它：创建/加入房间、对手离开都属于「换房」，
 * 若只复用上一房间的 React state，上一局的棋盘、聊天、对手昵称、
 * 连接状态与确认弹窗都会残留到下一房间（甚至能用旧连接在新房间落子）。
 * 因此换房时统一从这里取一份初始状态复位。
 */

import type { GameState } from '@webrtc-gomoku/core';
import { create as createGame } from '@webrtc-gomoku/core';
import type { TransportInfo } from '@webrtc-gomoku/shared';

import type { ChatItem, FlowState, ModalState } from './types';

export interface RoomSession {
  /** 全新空棋盘（可变对象，绝不复用） */
  game: GameState;
  messages: ChatItem[];
  peerName: string;
  connected: boolean;
  transport: TransportInfo | null;
  roomStatus: string;
  flow: FlowState;
  hostOfferCode: string;
  guestOfferInput: string;
  hostAnswerInput: string;
  guestAnswerCode: string;
  hostTimer: string;
  flowResult: { type: string; html: string } | null;
  modal: ModalState;
}

/** 已关闭的确认弹窗（回调为空实现，可安全调用）。 */
export function closedModal(): ModalState {
  return {
    open: false,
    title: '',
    text: '',
    onOk: () => {},
    onNo: () => {},
  };
}

/**
 * 一份全新的房间会话初始状态：换房（创建/加入/对手离开）时使用。
 */
export function createRoomSession(): RoomSession {
  return {
    game: createGame(),
    messages: [],
    peerName: '',
    connected: false,
    transport: null,
    roomStatus: '',
    flow: 'idle',
    hostOfferCode: '',
    guestOfferInput: '',
    hostAnswerInput: '',
    guestAnswerCode: '',
    hostTimer: '0:00',
    flowResult: null,
    modal: closedModal(),
  };
}
