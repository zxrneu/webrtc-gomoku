/**
 * 房间会话状态管理（Room-Scoped State Management）
 *
 * 【为什么需要这个文件？—— 前端常见“幽灵状态”Bug】：
 * 在多人联网游戏中，“换房”（退出当前房间、加入新房间、或者对手离开）是一个高危操作。
 * 如果只在 React 组件里零散地 `setConnected(false)`，往往会漏掉某些状态：
 * - 比如上一局棋盘上的棋子还留在屏幕上；
 * - 上一局的聊天记录还在；
 * - 甚至上一局对手发来的“是否同意悔棋”弹窗还在，新对手一进来直接弹窗！
 *
 * 【设计模式与架构原则】：
 * 1. 单一职责原则 (SRP)：把“重置一个纯净房间需要的所有数据”统一收敛在这一个模块；
 * 2. 工厂函数模式 (Factory Pattern)：绝不能导出一个静态常量对象 `const DEFAULT_SESSION = { ... }`！
 *    因为棋盘 `board` 是可变数组（Mutable Array），如果共享同一个对象引用，上一局下的子会直接污染新房间。
 *    因此必须使用工厂函数 `createRoomSession()`，每次调用都 new 出全新的独立数据对象。
 */

import type { GameState } from '@webrtc-gomoku/core';
import { create as createGame } from '@webrtc-gomoku/core';
import type { TransportInfo } from '@webrtc-gomoku/shared';

import type { ChatItem, FlowState, ModalState } from './types';

/**
 * 房间会话完整快照接口
 * 包含了一个全新房间所需的所有初始值
 */
export interface RoomSession {
  /** 全新空棋盘（深拷贝的全新独立对象，绝不与旧局共享引用） */
  game: GameState;
  /** 局内聊天记录列表（初始为空数组） */
  messages: ChatItem[];
  /** 对手昵称（未连通前为空字符串） */
  peerName: string;
  /** P2P 连通状态（初始为 false） */
  connected: boolean;
  /** 底层网络质量信息（未连通前为 null） */
  transport: TransportInfo | null;
  /** 房间状态提示文本（如“等待对手加入...”） */
  roomStatus: string;
  /** 手动连接模式流程状态（初始为空闲 'idle'） */
  flow: FlowState;
  /** 房主生成的 Offer 压缩连接码 */
  hostOfferCode: string;
  /** 加入方输入的 Offer 连接码 */
  guestOfferInput: string;
  /** 房主输入的 Answer 应答连接码 */
  hostAnswerInput: string;
  /** 加入方生成的 Answer 应答连接码 */
  guestAnswerCode: string;
  /** 房主创建房间等待倒计时文本（初始为 '0:00'） */
  hostTimer: string;
  /** 手动流程结果 HTML 提示 */
  flowResult: { type: string; html: string } | null;
  /** 模态交互弹窗状态（初始为关闭） */
  modal: ModalState;
}

/**
 * 安全的已关闭确认弹窗状态（安全空对象模式）
 *
 * 【设计小技巧】：
 * 将 `onOk` 和 `onNo` 预设为空实现函数 `() => {}`，
 * 即使界面在卸载动画未完成时触发了点击，也不会报 `TypeError: is not a function` 崩溃。
 *
 * @returns 处于关闭状态且具备安全回调的 ModalState 对象
 */
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
 * 核心工厂函数：生成一份完全独立、干净、无污染的全新房间会话初始状态
 *
 * 适用场景：
 * 1. 玩家点击“创建房间”或输入 4 位房号“加入房间”时；
 * 2. 收到信令 `peer-left`（对手中途退出了房间）时；
 * 3. 换房或点击离开房间时。
 *
 * @returns 一份全新的 RoomSession 数据对象
 */
export function createRoomSession(): RoomSession {
  return {
    game: createGame(),        // 每次重新分配 15x15 的全新空棋盘
    messages: [],              // 清空上一局的聊天气泡
    peerName: '',              // 清空对手昵称
    connected: false,          // 重置连接标识
    transport: null,           // 清空 RTT 与网络候选信息
    roomStatus: '',            // 清空房间状态提示
    flow: 'idle',              // 重置手动连接状态机
    hostOfferCode: '',         // 清空上一次的邀请码
    guestOfferInput: '',
    hostAnswerInput: '',
    guestAnswerCode: '',
    hostTimer: '0:00',
    flowResult: null,
    modal: closedModal(),      // 强制关闭所有遗留弹窗（防止把上一局的悔棋请求带到新房间）
  };
}

