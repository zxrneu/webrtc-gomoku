import type { Color, Move, PlayerColor, Point } from '@webrtc-gomoku/core';
import type { TransportInfo } from '@webrtc-gomoku/shared';

/**
 * ============================================================================
 * 前端交互私有类型定义 (UI-scoped Types)
 * ============================================================================
 */

/**
 * 手动连接模式（无信令服务器）的状态机流转阶段
 *
 * 流程顺序：
 * 1. idle: 空闲未开始状态
 * 2. host-wait: 房主点击“创建房间”生成 Offer 邀请码，等待加入方回复
 * 3. guest-invite: 加入方输入/扫了房主的邀请码，正在生成 Answer 应答码
 * 4. guest-wait: 加入方出码后，等待房主把应答码填入并完成握手
 * 5. connected: 双方 WebRTC DataChannel 成功建立直连，进入对局！
 */
export type FlowState = 'idle' | 'host-wait' | 'guest-invite' | 'guest-wait' | 'connected';

/**
 * 实时对局聊天消息结构
 */
export interface ChatItem {
  /** 消息唯一 ID（防 React key 冲突） */
  id: string;
  /** 发送方角色：self(我方) | peer(对方) | sys(系统提示，如加入/胜负公告) */
  sender: 'self' | 'peer' | 'sys';
  /** 聊天内容文本 */
  text: string;
  /** 发送时间（格式如 "12:30"） */
  time: string;
}

/**
 * 模态确认弹窗状态（用于处理悔棋申请、重开申请等双向协商交互）
 */
export interface ModalState {
  /** 弹窗是否可见 */
  open: boolean;
  /** 弹窗标题（如：“对方申请悔棋”） */
  title: string;
  /** 详细说明文本 */
  text: string;
  /** 点击“同意/确定”按钮的回调函数 */
  onOk: () => void;
  /** 点击“拒绝/取消”按钮的回调函数 */
  onNo: () => void;
}

/**
 * 当前正在进行的扫码目标角色
 * - 'guest-offer': 被邀请方正在扫描房主展示的邀请二维码
 * - 'host-answer': 房主正在扫描加入方出示的应答二维码
 * - null: 扫码弹窗处于关闭状态
 */
export type ScannerTarget = 'guest-offer' | 'host-answer' | null;

/**
 * 挂载在 window.__gomoku 上的全局对局状态快照（主要用于 Playwright E2E 自动化测试探测与断言）
 */
export interface AppState {
  /** 是否已建立 P2P 连接 */
  connected: boolean;
  /** 当前房间号（若无则为 null） */
  room: string | null;
  /** 本地玩家执子颜色：BLACK(1) 或 WHITE(2) */
  myColor: PlayerColor;
  /** 本地玩家昵称 */
  myName: string;
  /** 对手玩家昵称 */
  peerName: string;
  /** 是否是房主/发起方 */
  isHost: boolean;
  /** 当前落子步数历史序列 */
  moves: Move[];
  /** 游戏是否已经结束 */
  over: boolean;
  /** 获胜的 5 颗连珠坐标列表 */
  winLine: Point[] | null;
  /** 手动流程阶段状态 */
  flow: FlowState;
  /** 底层 WebRTC 链路质量信息 */
  transport: TransportInfo | null;
}

