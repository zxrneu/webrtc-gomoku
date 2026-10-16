import type { PlayerColor } from '@webrtc-gomoku/core';

/* ---------------- 对局协议（DataChannel） ---------------- */

export interface HelloMsg {
  t: 'hello';
  name: string;
}

export interface MoveMsg {
  t: 'move';
  x: number;
  y: number;
}

export interface ChatMsg {
  t: 'chat';
  text: string;
}

export interface UndoReqMsg {
  t: 'undo-req';
}

export interface UndoOkMsg {
  t: 'undo-ok';
}

export interface UndoNoMsg {
  t: 'undo-no';
}

export interface RestartReqMsg {
  t: 'restart-req';
}

export interface RestartOkMsg {
  t: 'restart-ok';
}

export interface RestartNoMsg {
  t: 'restart-no';
}

export interface ByeMsg {
  t: 'bye';
}

export type GameMessage =
  | HelloMsg
  | MoveMsg
  | ChatMsg
  | UndoReqMsg
  | UndoOkMsg
  | UndoNoMsg
  | RestartReqMsg
  | RestartOkMsg
  | RestartNoMsg
  | ByeMsg;

/* ---------------- 信令服务消息（WebSocket） ---------------- */

export interface ClientCreateMsg {
  t: 'create';
  room?: string;
}

export interface ClientJoinMsg {
  t: 'join';
  room: string;
  name?: string;
}

export interface ClientSignalMsg {
  t: 'signal';
  data: unknown;
}

export interface ClientLeaveMsg {
  t: 'leave';
}

export type ClientSignalingMsg =
  | ClientCreateMsg
  | ClientJoinMsg
  | ClientSignalMsg
  | ClientLeaveMsg;

export interface ServerCreatedMsg {
  t: 'created';
  room: string;
  peerId: string;
}

export interface ServerJoinedMsg {
  t: 'joined';
  room: string;
  peerId: string;
}

export interface ServerPeerJoinedMsg {
  t: 'peer-joined';
  peerId: string;
  name: string;
}

export interface ServerPeerLeftMsg {
  t: 'peer-left';
}

export interface ServerSignalMsg {
  t: 'signal';
  data: unknown;
}

export interface ServerErrorMsg {
  t: 'error';
  message: string;
}

export type ServerSignalingMsg =
  | ServerCreatedMsg
  | ServerJoinedMsg
  | ServerPeerJoinedMsg
  | ServerPeerLeftMsg
  | ServerSignalMsg
  | ServerErrorMsg;

/* ---------------- 手动连接码 Payload ---------------- */

export interface ManualOfferPayload {
  type: 'offer';
  sdp: string;
  name?: string;
}

export interface ManualAnswerPayload {
  type: 'answer';
  sdp: string;
  name?: string;
}

export type ManualPayload = ManualOfferPayload | ManualAnswerPayload;

/* ---------------- 传输状态 ---------------- */

export interface TransportInfo {
  candidateType?: string; // 'host' | 'srflx' | 'prflx' | 'relay'
  ipVersion?: string; // 'IPv4' | 'IPv6'
  rtt?: number; // ms
  summary?: string;
}

/* ---------------- 玩家角色 ---------------- */

export interface PlayerInfo {
  name: string;
  color: PlayerColor;
  tag: string; // '邀请方' | '加入方'
}
