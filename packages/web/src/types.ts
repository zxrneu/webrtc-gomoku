import type { Color, Move, PlayerColor, Point } from '@webrtc-gomoku/core';
import type { TransportInfo } from '@webrtc-gomoku/shared';

export type FlowState = 'idle' | 'host-wait' | 'guest-invite' | 'guest-wait' | 'connected';

export interface ChatItem {
  id: string;
  sender: 'self' | 'peer' | 'sys';
  text: string;
  time: string;
}

export interface ModalState {
  open: boolean;
  title: string;
  text: string;
  onOk: () => void;
  onNo: () => void;
}

export type ScannerTarget = 'guest-offer' | 'host-answer' | null;

export interface AppState {
  connected: boolean;
  room: string | null;
  myColor: PlayerColor;
  myName: string;
  peerName: string;
  isHost: boolean;
  moves: Move[];
  over: boolean;
  winLine: Point[] | null;
  flow: FlowState;
  transport: TransportInfo | null;
}
