import type { PlayerColor } from '@webrtc-gomoku/core';

/**
 * ============================================================================
 * 模块一：对局交互协议（通过 WebRTC RTCDataChannel 点对点直连传输）
 * ============================================================================
 * 【工作原理科普】：
 * 当两台设备通过 WebRTC 建立点对点直连（P2P）后，所有的落子、聊天、悔棋动作
 * 都是直接在两台手机/电脑之间光速互发，【完全不经过任何中间服务器】！
 * 每个消息都有一个唯一标识属性 `t`（type 的简写），用于区分是落子、聊天还是悔棋。
 */

/** 1. 握手问候消息：连接建立后交换各自的昵称 */
export interface HelloMsg {
  t: 'hello';
  /** 发送者的玩家昵称 */
  name: string;
}

/** 2. 落子同步消息：将自己在棋盘上的落子坐标同步给对手 */
export interface MoveMsg {
  t: 'move';
  /** 落子横坐标 (0 ~ 14) */
  x: number;
  /** 落子纵坐标 (0 ~ 14) */
  y: number;
}

/** 3. 局内文字聊天消息 */
export interface ChatMsg {
  t: 'chat';
  /** 聊天内容文本 */
  text: string;
}

/** 4. 请求悔棋：向对方发起撤销一步的申请 */
export interface UndoReqMsg {
  t: 'undo-req';
}

/** 5. 同意悔棋：对方点击“同意”，双方棋盘同步撤销一步 */
export interface UndoOkMsg {
  t: 'undo-ok';
}

/** 6. 拒绝悔棋：对方点击“拒绝” */
export interface UndoNoMsg {
  t: 'undo-no';
}

/** 7. 请求重新开局：一局结束后，申请再来一盘 */
export interface RestartReqMsg {
  t: 'restart-req';
}

/** 8. 同意重新开局：对方同意，重置棋盘与轮次 */
export interface RestartOkMsg {
  t: 'restart-ok';
}

/** 9. 拒绝重新开局 */
export interface RestartNoMsg {
  t: 'restart-no';
}

/** 10. 离开对局通知：某一方主动退出或关闭网页 */
export interface ByeMsg {
  t: 'bye';
}

/**
 * P2P 局内消息类型的联合集合（可区分联合 Discriminated Union）
 * 无论接收到什么消息，只需根据 msg.t 即可安全地做 switch-case 分发
 */
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

/**
 * ============================================================================
 * 模块二：信令服务器交互协议（通过 WebSocket 客户端与服务端双向通信）
 * ============================================================================
 * 【工作原理科普】：
 * 两个设备互不认识对方的 IP，怎么连上 WebRTC？
 * 这就需要“信令服务器”（Signaling Server）牵线搭桥。
 * 信令服务器只负责在两个人连上之前帮他们交换房间号、网络地址（ICE）和 SDP 名片，
 * 一旦两人 P2P 连通，信令服务器就功成身退了。
 */

// ----------------------------------------------------
// A. 客户端发给信令服务器的消息 (Client -> Server)
// ----------------------------------------------------

/** 客户端请求创建新房间 */
export interface ClientCreateMsg {
  t: 'create';
  /** 可选的自定义房间号（若不填由服务器随机分配 4 位字母数字） */
  room?: string;
}

/** 客户端请求加入已有房间 */
export interface ClientJoinMsg {
  t: 'join';
  /** 要加入的目标 4 位房号 */
  room: string;
  /** 加入者的昵称 */
  name?: string;
}

/** 客户端向服务端提交信令数据（SDP 或 ICE 候选），由服务端转发给同房间的对手 */
export interface ClientSignalMsg {
  t: 'signal';
  /** 透传的 WebRTC 握手数据（如 RTCSessionDescriptionInit 或 RTCIceCandidateInit） */
  data: unknown;
}

/** 客户端主动离开房间 */
export interface ClientLeaveMsg {
  t: 'leave';
}

/** 客户端发出的信令消息联合类型 */
export type ClientSignalingMsg =
  | ClientCreateMsg
  | ClientJoinMsg
  | ClientSignalMsg
  | ClientLeaveMsg;

// ----------------------------------------------------
// B. 信令服务器推给客户端的消息 (Server -> Client)
// ----------------------------------------------------

/** 服务端通知房主：房间创建成功 */
export interface ServerCreatedMsg {
  t: 'created';
  /** 最终分配的 4 位房间号 */
  room: string;
  /** 服务端分配给该客户端的唯一 Peer ID */
  peerId: string;
}

/** 服务端通知加入者：成功加入房间 */
export interface ServerJoinedMsg {
  t: 'joined';
  /** 加入的房间号 */
  room: string;
  /** 服务端分配给该客户端的唯一 Peer ID */
  peerId: string;
}

/** 服务端通知房主：对手已经进入房间 */
export interface ServerPeerJoinedMsg {
  t: 'peer-joined';
  /** 对手的 Peer ID */
  peerId: string;
  /** 对手的玩家昵称 */
  name: string;
}

/** 服务端通知：对手已经离开房间或掉线 */
export interface ServerPeerLeftMsg {
  t: 'peer-left';
}

/** 服务端转发来自对手的信令数据 */
export interface ServerSignalMsg {
  t: 'signal';
  /** 对手发出的 WebRTC 握手数据 */
  data: unknown;
}

/** 服务端错误通知（如：房间不存在、房间已满、房号格式错误等） */
export interface ServerErrorMsg {
  t: 'error';
  /** 错误描述原因 */
  message: string;
}

/** 服务端下发的信令消息联合类型 */
export type ServerSignalingMsg =
  | ServerCreatedMsg
  | ServerJoinedMsg
  | ServerPeerJoinedMsg
  | ServerPeerLeftMsg
  | ServerSignalMsg
  | ServerErrorMsg;

/**
 * ============================================================================
 * 模块三：无网/纯手动连接码载荷 (Manual Connection Payload)
 * ============================================================================
 * 当没有中央信令服务器时，通过将此 Payload 打包压缩为“邀请码”，在聊天软件中复制粘贴完成配对。
 */

/** 发起方生成的 Offer 名片 */
export interface ManualOfferPayload {
  type: 'offer';
  /** WebRTC 本地会话描述 SDP 字符串 */
  sdp: string;
  /** 房主昵称 */
  name?: string;
}

/** 接收方生成的 Answer 应答名片 */
export interface ManualAnswerPayload {
  type: 'answer';
  /** WebRTC 应答会话描述 SDP 字符串 */
  sdp: string;
  /** 应答方昵称 */
  name?: string;
}

/** 手动连接名片联合类型 */
export type ManualPayload = ManualOfferPayload | ManualAnswerPayload;

/**
 * ============================================================================
 * 模块四：UI 界面辅助展示数据类型 (Transport & Player)
 * ============================================================================
 */

/**
 * WebRTC 底层传输链路质量监控数据（用于界面网络状态小面板）
 */
export interface TransportInfo {
  /** 最终选中的 ICE 候选类型：host(局域网) | srflx(NAT穿透公网) | relay(中继服务器) */
  candidateType?: string;
  /** 网络协议版本：'IPv4' 或 'IPv6' */
  ipVersion?: string;
  /** 网络往返往延时 Round Trip Time（单位毫秒 ms） */
  rtt?: number;
  /** 格式化后的简短概览，如 "P2P直连 (局域网) · 3ms" */
  summary?: string;
}

/**
 * 玩家身份与角色信息
 */
export interface PlayerInfo {
  /** 玩家昵称 */
  name: string;
  /** 执子方：BLACK(黑棋先行) 或 WHITE(白棋后行) */
  color: PlayerColor;
  /** 身份标签：'邀请方' 或 '加入方' */
  tag: string;
}

