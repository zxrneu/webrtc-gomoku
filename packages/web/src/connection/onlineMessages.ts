/**
 * 联机对局消息处理器（数据通道消息 → 界面状态）。
 *
 * 为什么从 `App.tsx` 抽出来：
 * 1. `App.tsx` 同时承担「联机编排」与「人机编排」两套职责，消息分支（130+ 行）
 *    留在组件里会让「联机路径不得引用人机状态」这条红线只能靠人工审查守住；
 *    抽成纯工厂后，本文件**不 import 任何人机模块**，红线变成结构性事实；
 * 2. 分支本身是纯状态迁移（setGame / setMyColor / 弹窗 / 提示），
 *    依赖全部由 `OnlineMessageDeps` 显式注入，行为与原实现逐行等价。
 *
 * 硬约束（tasks.md T05 / 架构 §6）：`move` / `undo-*` / `restart-*` 分支
 * **只允许**操作 `setGame`，禁止触碰人机棋局。
 */

import type { GameState, PlayerColor } from '@webrtc-gomoku/core';
import { applyMove, currentColor, BLACK, WHITE } from '@webrtc-gomoku/core';
import type { Capabilities, GameMessage } from '@webrtc-gomoku/shared';
import { normalizeCapabilities } from '@webrtc-gomoku/shared';

import type { ModalState } from '../types';
import { sounds } from '../audio';
import type { WebRTCClient } from '../webrtc';
import type { ConnectionApi } from './useConnection';
import type { GameRequests } from './gameRequests';

/** 换边协商阶段（ref 承载，避免闭包过期） */
export type SwapPhase = 'idle' | 'outgoing' | 'incoming';

/** 消息处理器依赖（全部由 App 注入；ref 形态是为了永远读到最新值） */
export interface OnlineMessageDeps {
  /** 提交联机棋局（唯一允许写棋局的入口） */
  readonly setGame: (value: GameState | ((prev: GameState) => GameState)) => void;
  /** 提交本端执子颜色 */
  readonly setMyColor: (value: PlayerColor | ((prev: PlayerColor) => PlayerColor)) => void;
  /** 提交对手昵称 */
  readonly setPeerName: (value: string) => void;
  /** 提交确认弹窗状态 */
  readonly setModal: (value: ModalState | ((prev: ModalState) => ModalState)) => void;
  /** 提交「手动邀请码」连通标记 */
  readonly setManualConnected: (value: boolean) => void;
  /** 追加一条系统聊天消息 */
  readonly addSysMsg: (text: string) => void;
  /** 追加一条对手发来的聊天消息（聊天区样式与系统消息不同，必须区分） */
  readonly onPeerChat: (text: string) => void;
  /** 富媒体帧（meta/chunk/end/cancel/ack）转交媒体控制器 */
  readonly onMediaFrame?: (msg: GameMessage) => void;
  /** 对手能力集（旧版无字段 → 全 false） */
  readonly onPeerCapabilities?: (caps: Capabilities) => void;
  /** 轻提示 */
  readonly showToast: (message: string) => void;
  /** 是否已有确认弹窗占位（换边申请需要避让） */
  readonly isModalOpen: () => boolean;
  readonly gameRef: { current: GameState };
  readonly myColorRef: { current: PlayerColor };
  readonly isHostRef: { current: boolean };
  readonly swapPhaseRef: { current: SwapPhase };
  readonly awaitingColorRef: { current: boolean };
  readonly connRef: { current: ConnectionApi | null };
  readonly clientRef: { current: WebRTCClient | null };
  readonly requests?: GameRequests;
}

/**
 * 构造联机消息处理器。
 * @param deps 状态写入函数与 ref（由 App 注入）
 * @returns 处理一条 `GameMessage` 的函数
 */
export function createOnlineMessageHandler(deps: OnlineMessageDeps): (msg: GameMessage) => void {
  const {
    setGame,
    setMyColor,
    setPeerName,
    setModal,
    setManualConnected,
    addSysMsg,
    onPeerChat,
    onMediaFrame,
    onPeerCapabilities,
    showToast,
    isModalOpen,
    gameRef,
    myColorRef,
    isHostRef,
    swapPhaseRef,
    awaitingColorRef,
    connRef,
    requests,
  } = deps;

  return (msg: GameMessage): void => {
    if (requests?.handle(msg)) return;
    switch (msg.t) {
      case 'hello':
        setPeerName(msg.name || '对手');
        onPeerCapabilities?.(normalizeCapabilities(msg.capabilities));
        addSysMsg(`${msg.name || '对手'} 加入了对局`);
        if (!isHostRef.current && msg.hostColor) {
          awaitingColorRef.current = false;
          const next = msg.hostColor === BLACK ? WHITE : BLACK;
          setMyColor(next);
          myColorRef.current = next;
        }
        break;
      case 'color':
        if (!isHostRef.current) {
          awaitingColorRef.current = false;
          const nextColor = msg.color === BLACK ? WHITE : BLACK;
          setMyColor(nextColor);
          myColorRef.current = nextColor;
          addSysMsg(`房主选择了${msg.color === BLACK ? '执黑' : '执白'}，你被分配为${nextColor === BLACK ? '执黑' : '执白'}`);
        }
        break;
      case 'swap-req':
        if (requests?.hasPending()) { connRef.current?.send({ t: 'swap-no' }); return; }
        if (gameRef.current.over) { connRef.current?.send({ t: 'swap-no' }); return; }
        if (swapPhaseRef.current === 'outgoing') {
          if (isHostRef.current) {
            swapPhaseRef.current = 'idle';
            if (!connRef.current?.send({ t: 'swap-ok' })) { showToast('换边确认发送失败，请检查连接状态'); return; }
            setMyColor((c) => { const next = c === BLACK ? WHITE : BLACK; myColorRef.current = next; return next; });
            showToast('双方均申请换边，已完成换边'); addSysMsg('双方均申请换边，已完成换边');
          }
          return;
        }
        if (swapPhaseRef.current === 'incoming') return;
        if (isModalOpen()) { connRef.current?.send({ t: 'swap-no' }); return; }
        swapPhaseRef.current = 'incoming';
        setModal({
          open: true, title: '对方申请换边（切换执黑/执白）', text: '对手希望能互换执子颜色（黑白互换），是否同意？',
          onOk: () => {
            if (swapPhaseRef.current !== 'incoming') return;
            swapPhaseRef.current = 'idle';
            setModal((m) => ({ ...m, open: false }));
            if (gameRef.current.over) { connRef.current?.send({ t: 'swap-no' }); showToast('当前对局已结束，无法换边'); return; }
            if (!connRef.current?.send({ t: 'swap-ok' })) { showToast('换边确认发送失败，请检查连接状态'); return; }
            setMyColor((c) => { const next = c === BLACK ? WHITE : BLACK; myColorRef.current = next; return next; });
            addSysMsg('你同意了换边申请，双方已互换颜色'); showToast('双方已互换执黑/执白');
          },
          onNo: () => {
            swapPhaseRef.current = 'idle';
            setModal((m) => ({ ...m, open: false }));
            connRef.current?.send({ t: 'swap-no' }); addSysMsg('你拒绝了对方的换边申请');
          },
        });
        break;
      case 'swap-ok':
        if (swapPhaseRef.current !== 'outgoing') return;
        setModal((m) => (m.open && m.title.includes('换边') ? { ...m, open: false } : m));
        swapPhaseRef.current = 'idle';
        if (gameRef.current.over) return;
        setMyColor((c) => { const next = c === BLACK ? WHITE : BLACK; myColorRef.current = next; return next; });
        showToast('对方同意了换边申请，双方已互换颜色'); addSysMsg('对方同意了换边申请，双方已互换颜色');
        break;
      case 'swap-no':
        if (swapPhaseRef.current !== 'outgoing') return;
        swapPhaseRef.current = 'idle';
        setModal((m) => (m.open && m.title.includes('换边') ? { ...m, open: false } : m));
        showToast('对方拒绝了换边申请'); addSysMsg('对方拒绝了换边申请');
        break;
      case 'move':
        setGame((prevGame) => {
          const moveColor = currentColor(prevGame);
          const res = applyMove(prevGame, msg.x, msg.y, moveColor);
          if (res.ok) {
            sounds.playStone(moveColor === BLACK);
            if (res.event === 'win') {
              sounds.playWin();
              addSysMsg(`游戏结束，${moveColor === BLACK ? '黑方' : '白方'} 胜！`);
            } else if (res.event === 'draw') {
              addSysMsg('棋盘下满，平局！');
            }
          }
          return { ...prevGame };
        });
        break;
      case 'chat':
        onPeerChat(msg.text);
        sounds.playNotify();
        break;
      case 'media-meta':
      case 'media-chunk':
      case 'media-end':
      case 'media-cancel':
      case 'media-ack':
        onMediaFrame?.(msg);
        break;
      case 'bye':
        // 对手主动 bye → 交给编排器收敛为 PEER_GONE（禁止在这里自己改连接状态）
        connRef.current?.notifyPeerGone();
        setManualConnected(false);
        addSysMsg('对方退出了对局');
        showToast('对方已断开连接');
        break;
      default:
        break;
    }
  };
}
