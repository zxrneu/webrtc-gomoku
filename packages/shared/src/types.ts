import type { ClientLobbyMsg, ServerLobbyMsg } from './lobby/types';
import type { Move, PlayerColor } from '@webrtc-gomoku/core';

/**
 * ============================================================================
 * 模块一：对局交互协议（通过 WebRTC RTCDataChannel 点对点直连传输）
 * ============================================================================
 * 【工作原理科普】：
 * 当两台设备通过 WebRTC 建立点对点直连（P2P）后，所有的落子、聊天、悔棋动作
 * 都是直接在两台手机/电脑之间光速互发，【完全不经过任何中间服务器】！
 * 每个消息都有一个唯一标识属性 `t`（type 的简写），用于区分是落子、聊天还是悔棋。
 */

/** 能力集（N1）：hello 的可选字段；旧版无该字段 = 全 false */
export interface Capabilities {
  /** 扫码配对能力 */
  qr: boolean;
  /** 图片 + 文件消息能力 */
  file: boolean;
  /** 语音消息能力（本期语义；实时通话另属 F3） */
  audio: boolean;
  /** 视频通话能力（占位，本期恒 false） */
  video: boolean;
}

/** 富媒体类型判别：image=图片气泡；file=文件卡片；audio=语音消息 */
export type MediaKind = 'image' | 'file' | 'audio';

/** 1. 握手问候消息：连接建立后交换各自的昵称与能力集 */
export interface HelloMsg {
  t: 'hello';
  /** 发送者的玩家昵称 */
  name: string;
  /** 发送者（若为房主）指定的房主执子颜色 */
  hostColor?: PlayerColor;
  /** 能力协商（M7 增量；旧版不下发 → 按全 false 处理） */
  capabilities?: Capabilities;
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
 * 11. 应用层心跳探测（v1.1 增量）
 *
 * 同一条消息用于两条通道：
 * - WS：客户端 → 服务端（服务端立即回 `pong`），用于发现「半开连接」；
 * - DC：对端 ↔ 对端，用于发现「P2P 已死但 PC 还没报 disconnected」。
 *
 * 旧客户端收到后会走 `switch` 的 default（无分支 → 忽略），不崩。
 */
export interface PingMsg {
  t: 'ping';
  /** 发送时刻（epoch 毫秒，可选；仅用于诊断） */
  ts?: number;
}

/** 12. 应用层心跳应答（v1.1 增量） */
export interface PongMsg {
  t: 'pong';
  /** 原样回带 ping 的 ts（可选） */
  ts?: number;
}

/**
 * 13. 棋谱对账（v1.1 增量，仅走 DataChannel）
 *
 * - 房主 → 加入方：`{ t:'sync', moves, rev }`（房主是唯一权威，D3）
 * - 加入方 → 房主：`{ t:'sync', moves:[], rev, ack:true }`（回执，复用同一 `t`，Q-B 已回签）
 *
 * 旧客户端没有 `sync` 分支 → 忽略，不崩；但不会 ack，房主侧按超时兜底（§10.3）。
 */
export interface SyncMsg {
  t: 'sync';
  /** 权威棋谱（回执时为空数组） */
  moves: Move[];
  /** 棋谱版本号（房主每次对账递增，用于幂等与回执匹配） */
  rev?: number;
  /** 是否为回执 */
  ack?: boolean;
}

/** 14. 执色指定/同步消息：房主选边时通知对端（1: 黑, 2: 白） */
export interface ColorMsg {
  t: 'color';
  /** 房主选择的颜色 */
  color: PlayerColor;
}

/** 15. 请求换边：对局中向对方发起切换执黑/执白的申请 */
export interface SwapReqMsg {
  t: 'swap-req';
}

/** 16. 同意换边：对方点击同意，双方执子颜色互换 */
export interface SwapOkMsg {
  t: 'swap-ok';
}

/** 17. 拒绝换边：对方点击拒绝 */
export interface SwapNoMsg {
  t: 'swap-no';
}

/**
 * 18. 富媒体会话元信息（M7 增量，发送第一帧）
 *
 * 富媒体不复用 `chat` 帧：旧客户端 codec 要求 `chat.text` 为字符串，
 * 新增独立帧族才能保证「旧端解析失败即丢弃」而非误判为合法聊天。
 */
export interface MediaMetaMsg {
  t: 'media-meta';
  /** 传输会话 ID（收发双方配对用） */
  id: string;
  /** 富媒体类型 */
  kind: MediaKind;
  /** 原始文件名（已 sanitize；仅展示，禁止作为路径） */
  name: string;
  /** 字节数（接收端复核） */
  size: number;
  mime: string;
  /** 分片大小（16–64KB） */
  chunkSize: number;
  /** 分片总数 = ceil(size/chunkSize) */
  chunks: number;
  /** 语音消息时长（毫秒，仅 kind='audio' 时下发） */
  durationMs?: number;
  /** 文件完整性哈希（SHA-256 十六进制字符串） */
  hash?: string;
}

/** 19. 富媒体数据分片（data 为 base64url 编码的分片字节） */
export interface MediaChunkMsg {
  t: 'media-chunk';
  id: string;
  /** 0 基分片序号 */
  seq: number;
  /** base64url 编码的分片内容 */
  data: string;
}

/** 20. 富媒体发送完成（发送最后一帧） */
export interface MediaEndMsg {
  t: 'media-end';
  id: string;
}

/** 21. 富媒体取消（任一方可发；对端收到即丢弃会话并中止发送） */
export interface MediaCancelMsg {
  t: 'media-cancel';
  id: string;
}

/** 22. 富媒体接收确认（对 meta 的接受/拒绝决策，及完成后回执） */
export interface MediaAckMsg {
  t: 'media-ack';
  id: string;
  ok: boolean;
  /** 决策/结果原因码（web 层映射为中文文案） */
  reason?: 'accepted' | 'rejected-size' | 'rejected-type' | 'unsupported' | 'done';
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
  | ByeMsg
  | PingMsg
  | PongMsg
  | SyncMsg
  | ColorMsg
  | SwapReqMsg
  | SwapOkMsg
  | SwapNoMsg
  | MediaMetaMsg
  | MediaChunkMsg
  | MediaEndMsg
  | MediaCancelMsg
  | MediaAckMsg;


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
  /** 房主昵称（v1.1 增量：用于服务端座位记录，旧服务端忽略） */
  name?: string;
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

/** 客户端应用层心跳（v1.1 增量）：服务端收到后立即回 pong，不改任何状态 */
export interface ClientPingMsg {
  t: 'ping';
  /** 发送时刻（epoch 毫秒，可选） */
  ts?: number;
}

/**
 * 客户端请求占回原座位（v1.1 增量，**非幂等**：成功后 token 轮换）
 *
 * 只在 socket 重连成功后的第一时刻发送；服务端在 60s 宽限期内校验通过即恢复座位。
 */
export interface ClientResumeMsg {
  t: 'resume';
  /** 原房间号 */
  room: string;
  /** 服务端上次分配给该客户端的 Peer ID */
  peerId: string;
  /** 座位凭证（随 created/joined 下发，只走内存，绝不进 URL） */
  token: string;
}

/** 客户端发出的信令消息联合类型 */
export type ClientSignalingMsg =
  | ClientCreateMsg
  | ClientJoinMsg
  | ClientSignalMsg
  | ClientLeaveMsg
  | ClientPingMsg
  | ClientResumeMsg
  | ClientLobbyMsg;

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
  /** 座位凭证（v1.1 增量；旧服务端不下发，客户端需容忍缺失） */
  token?: string;
}

/** 服务端通知加入者：成功加入房间 */
export interface ServerJoinedMsg {
  t: 'joined';
  /** 加入的房间号 */
  room: string;
  /** 服务端分配给该客户端的唯一 Peer ID */
  peerId: string;
  /** 座位凭证（v1.1 增量） */
  token?: string;
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
  /** 错误描述原因（逐字复用 v1 文案，一个标点都不许改） */
  message: string;
  /** 机器可读错误码（v1.1 增量；旧服务端不下发 → 客户端回退到文案匹配） */
  code?: ServerErrorCode;
}

/** 服务端错误码（v1.1 增量，K2 逐字） */
export type ServerErrorCode =
  | 'ROOM_FORMAT'
  | 'ROOM_EXISTS'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'UNKNOWN_TYPE'
  | 'RESUME_REJECTED'
  | 'RESUME_TOKEN_INVALID';

/** 服务端心跳应答（v1.1 增量） */
export interface ServerPongMsg {
  t: 'pong';
  /** 原样回带客户端 ping 的 ts */
  ts?: number;
}

/** 服务端通知：对手连接断开，进入宽限期（v1.1 增量，**替代**立即 peer-left） */
export interface ServerPeerOfflineMsg {
  t: 'peer-offline';
  /** 宽限期秒数（客户端 UI 倒计时以本值为准） */
  graceSec: number;
}

/** 服务端通知：对手在宽限期内恢复了连接（v1.1 增量） */
export interface ServerPeerOnlineMsg {
  t: 'peer-online';
}

/** 服务端通知：resume 校验通过，座位已恢复（v1.1 增量） */
export interface ServerResumedMsg {
  t: 'resumed';
  /** 房间号 */
  room: string;
  /** 恢复后的 Peer ID（与请求一致） */
  peerId: string;
  /** 轮换后的新座位凭证（旧 token 立即失效，防重放） */
  token: string;
  /** 当前是否仍有对手占座；缺省时兼容旧服务端，沿用本地记录。 */
  peerPresent?: boolean;
}

/** 服务端下发的信令消息联合类型 */
export type ServerSignalingMsg =
  | ServerCreatedMsg
  | ServerJoinedMsg
  | ServerPeerJoinedMsg
  | ServerPeerLeftMsg
  | ServerSignalMsg
  | ServerErrorMsg
  | ServerPongMsg
  | ServerPeerOfflineMsg
  | ServerPeerOnlineMsg
  | ServerResumedMsg
  | ServerLobbyMsg;

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
  /** 房主选择的颜色 */
  hostColor?: PlayerColor;
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
  /**
   * 最终选中的 ICE 候选类型：
   * - host: 局域网/本机直连
   * - srflx (Server Reflexive): 通过 STUN 服务器探测出的公网 NAT 映射地址
   * - prflx (Peer Reflexive): 对等反射地址（双方在打洞互发测试包时对端直接探测到的动态端口直连）
   * - relay: 通过 TURN 中继服务器中转流量（打洞失败时的保底方案）
   */
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

