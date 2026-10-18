/**
 * 顶层应用协调器与状态机主控 (App.tsx)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { GameState, Move, PlayerColor } from '@webrtc-gomoku/core';
import {
  create as createGame,
  applyMove,
  undo as undoMove,
  currentColor,
  BLACK,
  WHITE,
} from '@webrtc-gomoku/core';
import type {
  ConnSideEffect,
  GameMessage,
  TransportInfo,
} from '@webrtc-gomoku/shared';
import { unpack } from '@webrtc-gomoku/shared';

import type { ChatItem, FlowState, ModalState, ScannerTarget } from './types';
import { sounds } from './audio';
import { detectQrFromSource, renderQrToCanvas } from './qr';
import { createRoomSession } from './roomSession';
import type { WebRTCClient } from './webrtc';
import type { ConnectionApi } from './connection/useConnection';
import { useConnection } from './connection/useConnection';

import { Header } from './components/Header/Header';
import { Board } from './components/Board/Board';
import { ConnectionBanner } from './components/Banner/ConnectionBanner';
import { ConnectionPanel } from './components/Connection/ConnectionPanel';
import { GameStatus } from './components/GameStatus/GameStatus';
import { Chat } from './components/Chat/Chat';
import { ScannerModal } from './components/Scanner/ScannerModal';
import { ConfirmModal } from './components/Modal/ConfirmModal';
import { Toast } from './components/Toast/Toast';

import styles from './App.module.css';

export const App: React.FC = () => {
  // 核心对局状态
  const [game, setGame] = useState<GameState>(() => createGame());
  const [myColor, setMyColor] = useState<PlayerColor>(BLACK);
  /**
   * 「手动邀请码」零服务器模式下的连通标记（保留 v1 行为）。
   * 房间模式的连通状态**只来自** `conn.status.isPlayable`，两者取或即为 `connected`。
   */
  const [manualConnected, setManualConnected] = useState(false);
  const [myName, setMyName] = useState('');
  const [peerName, setPeerName] = useState('');
  const [isHost, setIsHost] = useState(true);

  // 界面交互状态
  const [activeTab, setActiveTab] = useState<'room' | 'manual'>('room');
  const [inputRoomCode, setInputRoomCode] = useState('');
  const [flow, setFlow] = useState<FlowState>('idle');
  const [hostOfferCode, setHostOfferCode] = useState('');
  const [guestOfferInput, setGuestOfferInput] = useState('');
  const [hostAnswerInput, setHostAnswerInput] = useState('');
  const [guestAnswerCode, setGuestAnswerCode] = useState('');
  const [hostTimer, setHostTimer] = useState('0:00');
  const [hostTextFolded, setHostTextFolded] = useState(true);
  const [guestTextFolded, setGuestTextFolded] = useState(true);
  const [transport, setTransport] = useState<TransportInfo | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showMoveNumbers, setShowMoveNumbers] = useState(false);
  const [messages, setMessages] = useState<ChatItem[]>([]);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [modal, setModal] = useState<ModalState>({ open: false, title: '', text: '', onOk: () => {}, onNo: () => {} });

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2400);
  }, []);

  const addSysMsg = useCallback((text: string) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setMessages((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), sender: 'sys', text, time },
    ]);
  }, []);

  /* ---------------- 连接编排接线（唯一状态源） ---------------- */

  const gameRef = useRef<GameState>(game);
  gameRef.current = game;
  const myColorRef = useRef<PlayerColor>(myColor);
  myColorRef.current = myColor;
  const myNameRef = useRef(myName);
  myNameRef.current = myName;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const swapPhaseRef = useRef<'idle' | 'outgoing' | 'incoming'>('idle');
  const hasConnectedRef = useRef(false);
  const awaitingColorRef = useRef(false);

  /** 底层 WebRTC 客户端（仅「手动邀请码」模式与 e2e 诊断需要直接读） */
  const clientRef = useRef<WebRTCClient | null>(null);
  const connRef = useRef<ConnectionApi | null>(null);
  const handleGameMessageRef = useRef<(msg: GameMessage) => void>(() => {});
  const handleConnEventRef = useRef<(e: ConnSideEffect) => void>(() => {});

  const sendHello = useCallback(() => {
    const name = myNameRef.current || (isHostRef.current ? '房主' : '玩家');
    connRef.current?.send({ t: 'hello', name, hostColor: isHostRef.current ? myColorRef.current : undefined });
  }, []);
  const conn = useConnection({
    onGameMessage: (msg) => handleGameMessageRef.current(msg),
    onEvent: (e) => handleConnEventRef.current(e),
    getLocalMoves: () => gameRef.current.moves,
    onMovesReplaced: (moves) => {
      // 加入方对账：按房主权威棋谱整盘重放（颜色顺序与胜负判定由 core 保证）
      const next = createGame();
      for (const m of moves) {
        const res = applyMove(next, m.x, m.y, m.c);
        if (!res.ok) break;
      }
      setGame({ ...next });
    },
    onTransportUpdate: (info) => setTransport(info),
    onP2pConnected: () => {
      hasConnectedRef.current = true;
      // 房间模式由编排器的 `connected` 副作用负责；这里只兜「手动邀请码」模式
      if (connRef.current && connRef.current.status.state !== 'IDLE') return;
      setManualConnected(true);
      setFlow('connected');
      showToast('P2P 连接已建立！');
      addSysMsg('P2P 直连已建立，开始对局！');
      sounds.playNotify();
      sendHello();
    },
    onP2pDisconnected: () => {
      if (clientRef.current?.dc?.readyState !== 'open') {
        swapPhaseRef.current = 'idle';
        awaitingColorRef.current = !isHostRef.current;
        setModal((m) => m.title.includes('换边') ? { ...m, open: false } : m);
      }
      if (connRef.current && connRef.current.status.state !== 'IDLE') return;
      setManualConnected(false);
      setTransport(null);
    },
  });
  connRef.current = conn;
  clientRef.current = conn.client;

  /** 唯一业务判据：编排器 CONNECTED，或手动邀请码模式已直连 */
  const connected = conn.status.isPlayable || manualConnected;
  /** D4：对手处于宽限期时棋盘不可落子，但不显示「未连接」遮罩 */
  const boardConnected = connected && conn.status.peerOfflineInMs === null;
  /** 房间号一律以服务端下发的为准（created / joined / resumed） */
  const roomCode = conn.status.room ?? '';

  // 对局数据通道消息接收
  const handleGameMessage = useCallback(
    (msg: GameMessage) => {
      switch (msg.t) {
        case 'hello':
          setPeerName(msg.name || '对手');
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
          if (modal.open) { connRef.current?.send({ t: 'swap-no' }); return; }
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
          setMessages((prev) => [
            ...prev,
            { id: Math.random().toString(36).slice(2), sender: 'peer', text: msg.text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
          ]);
          sounds.playNotify();
          break;
        case 'undo-req':
          if (swapPhaseRef.current !== 'idle') { connRef.current?.send({ t: 'undo-no' }); return; }
          setModal({
            open: true, title: '对方申请悔棋', text: '对手希望能撤回最后一手，是否同意？',
            onOk: () => { setModal((m) => ({ ...m, open: false })); setGame((g) => { undoMove(g); return { ...g }; }); clientRef.current?.sendMessage({ t: 'undo-ok' }); addSysMsg('你同意了对方的悔棋申请'); },
            onNo: () => { setModal((m) => ({ ...m, open: false })); clientRef.current?.sendMessage({ t: 'undo-no' }); addSysMsg('你拒绝了对方的悔棋申请'); },
          });
          break;
        case 'undo-ok':
          setGame((g) => { undoMove(g); return { ...g }; });
          showToast('对方同意了悔棋'); addSysMsg('对方同意了悔棋申请');
          break;
        case 'undo-no':
          showToast('对方拒绝了悔棋申请'); addSysMsg('对方拒绝了悔棋申请');
          break;
        case 'restart-req':
          if (swapPhaseRef.current !== 'idle') { connRef.current?.send({ t: 'restart-no' }); return; }
          setModal({
            open: true, title: '对方申请重新开始', text: '对手希望能重开一局，是否同意？',
            onOk: () => { setModal((m) => ({ ...m, open: false })); setGame(createGame()); clientRef.current?.sendMessage({ t: 'restart-ok' }); addSysMsg('对局已重新开始'); },
            onNo: () => { setModal((m) => ({ ...m, open: false })); clientRef.current?.sendMessage({ t: 'restart-no' }); addSysMsg('你拒绝了对方的重开申请'); },
          });
          break;
        case 'restart-ok':
          setGame(createGame()); showToast('对方同意重开一局'); addSysMsg('对局已重新开始');
          break;
        case 'restart-no':
          showToast('对方拒绝了重开申请'); addSysMsg('对方拒绝了重开申请');
          break;

        case 'bye':
          // 对手主动 bye → 交给编排器收敛为 PEER_GONE（禁止在这里自己改连接状态）
          connRef.current?.notifyPeerGone();
          setManualConnected(false);
          addSysMsg('对方退出了对局');
          showToast('对方已断开连接');
          break;
      }
    },
    [myColor, modal.open, addSysMsg, showToast]
  );

  // 让编排器永远拿到最新的消息处理器（避免 useCallback 闭包过期）
  handleGameMessageRef.current = handleGameMessage;

  const handleToggleMoveNumbers = useCallback(() => {
    setShowMoveNumbers((v) => !v);
  }, []);

  const handleToggleColor = useCallback(() => {
    if (game.over) { showToast('当前对局已结束，请重新开局后再换边'); return; }
    if (!connected) {
      if (hasConnectedRef.current) { showToast('请等待连接恢复后再申请换边'); return; }
      const next = myColor === BLACK ? WHITE : BLACK;
      setMyColor(next); myColorRef.current = next;
      showToast(next === BLACK ? '已选择执黑（先行）' : '已选择执白（后手）');
      return;
    }
    if (swapPhaseRef.current !== 'idle') { showToast('正在协商换边，请先完成当前申请'); return; }
    swapPhaseRef.current = 'outgoing';
    const sent = connRef.current?.send({ t: 'swap-req' }) ?? false;
    if (!sent) {
      swapPhaseRef.current = 'idle';
      showToast('换边申请发送失败，请检查连接状态');
      return;
    }
    showToast('已发送换边申请，等待对方同意…');
  }, [connected, game.over, myColor, showToast]);

  // 本地落子逻辑
  const handleLocalMove = useCallback(
    (x: number, y: number) => {
      if (awaitingColorRef.current) { showToast('正在恢复执子颜色，请稍后落子'); return; }
      if (swapPhaseRef.current !== 'idle') { showToast('正在协商换边，请稍后落子'); return; }
      if (!connected) {
        showToast('请先连接对手后再落子');
        return;
      }
      if (game.over) {
        showToast('游戏已结束，点击「再来一局」重新开始');
        return;
      }
      if (currentColor(game) !== myColor) {
        showToast('当前不是你的回合');
        return;
      }

      setGame((prevGame) => {
        const res = applyMove(prevGame, x, y, myColor);
        if (!res.ok) {
          if (res.reason === 'occupied') showToast('该位置已有落子');
          return prevGame;
        }

        sounds.playStone(myColor === BLACK);
        // 落子发送：失败必须可见，并立刻触发一次 P2P 探测（R9，绝不静默丢子）
        const sent = connRef.current?.send({ t: 'move', x, y }) ?? false;
        connRef.current?.notifyLocalMove();
        if (!sent) showToast('连接不稳定，正在自动恢复…');

        if (res.event === 'win') {
          sounds.playWin();
          addSysMsg(`游戏结束，你获得了胜利！`);
        } else if (res.event === 'draw') {
          addSysMsg('棋盘下满，平局！');
        }

        return { ...prevGame };
      });
    },
    [connected, game, myColor, showToast, addSysMsg]
  );

  // 悔棋操作
  const handleUndo = useCallback(() => {
    if (swapPhaseRef.current !== 'idle') { showToast('请先完成换边协商'); return; }
    if (!connected || game.over || game.moves.length === 0) return;
    connRef.current?.send({ t: 'undo-req' });
    showToast('已发送悔棋申请，等待对方同意…');
  }, [connected, game.over, game.moves.length, showToast]);

  // 重开操作
  const handleRestart = useCallback(() => {
    if (swapPhaseRef.current !== 'idle') { showToast('请先完成换边协商'); return; }
    if (!connected) return;
    connRef.current?.send({ t: 'restart-req' });
    showToast('已发送重新开始申请，等待对方同意…');
  }, [connected, showToast]);

  // 聊天发送
  const handleSendChat = useCallback(
    (text: string) => {
      if (!connected || !text.trim()) return;
      connRef.current?.send({ t: 'chat', text });
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).slice(2),
          sender: 'self',
          text,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    },
    [connected]
  );

  /* ---------------- 手动邀请码对局流程 ---------------- */

  const startHostFlow = async () => {
    if (!clientRef.current) return;
    setIsHost(true);
    setFlow('host-wait');
    try {
      const offer = await clientRef.current.createHostOffer(myName || '房主', myColor);
      setHostOfferCode(offer);
    } catch (err) {
      alert('生成邀请码失败：' + (err as Error).message);
      setFlow('idle');
    }
  };

  const startGuestFlow = () => {
    setIsHost(false);
    setMyColor(WHITE);
    setFlow('guest-invite');
  };


  const connectedRef = useRef(connected);
  const diagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flowResult, setFlowResult] = useState<{ type: string; html: string } | null>(null);

  // 复位房间会话（只清界面态，连接生命周期由编排器负责）
  const resetRoomSession = useCallback(() => {
    swapPhaseRef.current = 'idle'; hasConnectedRef.current = false; awaitingColorRef.current = false;
    const fresh = createRoomSession();
    setGame(fresh.game); setMessages(fresh.messages); setPeerName(fresh.peerName);
    setManualConnected(false); setTransport(fresh.transport); setFlow(fresh.flow);
    setHostOfferCode(fresh.hostOfferCode); setGuestOfferInput(fresh.guestOfferInput);
    setHostAnswerInput(fresh.hostAnswerInput); setGuestAnswerCode(fresh.guestAnswerCode);
    setHostTimer(fresh.hostTimer); setFlowResult(fresh.flowResult); setModal(fresh.modal);
  }, []);

  useEffect(() => {
    connectedRef.current = connected;
    if (!connected) return;
    if (diagTimerRef.current) clearTimeout(diagTimerRef.current);
    // `flow-result` 由 ConnectionPanel 依据本 state 渲染，不需要再直接操作 DOM
    setFlowResult({
      type: 'ok',
      html: '<b>✅ 连接成功</b><br>对局数据通过浏览器 P2P DataChannel 直传',
    });
  }, [connected]);

  const diagnoseFailure = useCallback(() => {
    if (diagTimerRef.current) clearTimeout(diagTimerRef.current);
    const items = ['双方已交换候选但仍无法互通：可能处于对称型 NAT 或企业防火墙后', '可尝试：双方都切到手机热点；或自建/租用 TURN 服务器兜底'];
    setFlowResult({ type: 'bad', html: '<b>⚠️ 连接失败</b><ul>' + items.map((i) => '<li>' + i + '</li>').join('') + '</ul>' });
    showToast('P2P 连接失败，请查看右侧「邀请对局」面板中的原因说明');
  }, [showToast]);


  const scheduleDiag = useCallback(() => {
    if (diagTimerRef.current) clearTimeout(diagTimerRef.current);
    diagTimerRef.current = setTimeout(() => {
      if (!connectedRef.current) {
        diagnoseFailure();
      }
    }, 15000);
  }, [diagnoseFailure]);

  const handleGuestGenerateAnswer = async () => {
    if (!clientRef.current || !guestOfferInput.trim()) {
      alert('请先输入或扫描对方发来的邀请码');
      return;
    }
    try {
      try {
        const payload = await unpack<{ hostColor?: PlayerColor }>(guestOfferInput.trim());
        if (payload?.hostColor) {
          const next = payload.hostColor === BLACK ? WHITE : BLACK;
          setMyColor(next);
          myColorRef.current = next;
        }
      } catch {}
      const answer = await clientRef.current.handleGuestOffer(
        guestOfferInput.trim(),
        myName || '被邀请方'
      );
      setGuestAnswerCode(answer);
      setFlow('guest-wait');
      showToast('应答码已生成');
      scheduleDiag();
    } catch (err) {
      alert('解析邀请码失败：' + (err as Error).message);
    }

  };

  const handleHostFinish = async () => {
    if (!clientRef.current || !hostAnswerInput.trim()) {
      alert('请先粘贴对方发来的应答码');
      return;
    }
    try {
      await clientRef.current.finishHostConnection(hostAnswerInput.trim());
      showToast('应答码解析成功，等待 P2P 通道建立…');
      scheduleDiag();
    } catch (err) {
      alert('解析应答码失败：' + (err as Error).message);
    }
  };

  // 复制文本码到剪贴板
  const copyText = (text: string, tip: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(tip)).catch(() => showToast('请手动全选复制'));
    } else {
      showToast('复制成功');
    }
  };

  // 房间联机：编排器副作用 → 界面反馈
  const handleConnEvent = useCallback(
    (e: ConnSideEffect) => {
      switch (e.type) {
        case 'connected':
          hasConnectedRef.current = true;
          showToast('P2P 连接已建立！');
          addSysMsg('P2P 直连已建立，开始对局！');
          sounds.playNotify();
          sendHello();
          break;

        case 'restored':
          if (isHostRef.current) connRef.current?.send({ t: 'color', color: myColorRef.current });
          showToast('已恢复连接');
          addSysMsg(`连接已自动恢复（${e.via === 'ws-only' ? '信令通道' : '直连'}），棋谱已对齐`);
          break;
        case 'failed':
          swapPhaseRef.current = 'idle';
          showToast('连接已断开，棋盘已保留');
          addSysMsg('连接已断开，棋盘已保留；可点击顶部「立即重试」');
          break;
        case 'peer-offline':
          addSysMsg(`对手网络不稳定，正在重连…（宽限 ${e.graceSecs}s）`);
          break;
        case 'peer-online':
          addSysMsg('对手已恢复连接');
          break;
        case 'peer-gone':
          // 宽限到期、对手真的走了：必须整盘复位（moves / 聊天 / 对手昵称 / 弹窗）
          setManualConnected(false);
          resetRoomSession();
          addSysMsg('对手已离开房间');
          showToast('对手已离开房间');
          break;
        case 'room-ready':
          // 会话已提交（首次建房/入房或换房成功）—— 清盘与角色切换都在此刻发生
          resetRoomSession();
          setIsHost(e.role === 'host');
          if (e.role === 'guest') {
            setMyColor(WHITE);
            myColorRef.current = WHITE;
          }
          break;
        case 'join-rejected':
          // 换房被拒：只提示服务端原文，不动任何对局状态
          showToast(e.message);
          break;
        case 'room-invalid':
          showToast(e.message || '房间已失效');
          setModal({
            open: true,
            title: '房间已失效',
            text: `房间 ${e.room} 已失效（服务器可能重启过）。可以用同一房号重建，棋盘会保留。`,
            onOk: () => {
              setModal((m) => ({ ...m, open: false }));
              connRef.current?.createRoom(e.room, myNameRef.current || '房主');
            },
            onNo: () => setModal((m) => ({ ...m, open: false })),
          });
          break;
        case 'sync-applied':
          if (e.mismatch) addSysMsg('棋盘已按对手棋谱对齐');
          break;
        case 'degraded-to-v1':
          // 服务端是 v1：已降级为「重连即重进」，无需打扰用户
          break;
        default:
          break;
      }
    },
    [showToast, addSysMsg, resetRoomSession, sendHello]
  );
  handleConnEventRef.current = handleConnEvent;

  const handleCreateRoom = () => {
    // 房号由客户端随机生成 4 位；服务端仍会校验格式与重复，最终以 created 下发为准。
    // 注意：这里**不**清盘 —— 换房/建房要等服务端确认（room-ready）后才提交，
    // 否则建房失败会把正在进行的对局整局拆掉。
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    connRef.current?.createRoom(code, myName || '房主');
  };

  const handleJoinRoom = () => {
    const code = inputRoomCode.trim().toUpperCase();
    if (!code) {
      alert('请输入4位房间号');
      return;
    }
    // 同上：确认后提交，输错房号只 toast，不打断当前对局
    connRef.current?.joinRoom(code, myName || '玩家');
  };

  /* ---------------- 扫码识别处理 ---------------- */

  const scannerTargetRef = useRef<ScannerTarget>(null);

  /** 扫码弹层完全由 React 状态驱动（ScannerModal 自带遮罩与标题），无需操作 DOM */
  const openScannerModal = (target: ScannerTarget) => {
    scannerTargetRef.current = target;
    setScannerTarget(target);
  };

  const closeScannerModal = () => {
    scannerTargetRef.current = null;
    setScannerTarget(null);
  };

  const handleScannedText = async (text: string) => {
    const code = text.trim();
    if (!code) return false;

    let payload: { type?: string } | null = null;
    try {
      payload = await unpack<{ type?: string }>(code);
    } catch {
      payload = null;
    }
    if (!payload || !payload.type) {
      showToast('该二维码不是有效的五子棋对局二维码');
      return false;
    }

    const currentTarget = scannerTargetRef.current || scannerTarget;

    if (currentTarget === 'guest-offer') {
      if (payload.type !== 'offer') {
        showToast('该二维码不是有效的邀请码（可能是应答码或非对局二维码）');
        return false;
      }
      const offerPayload = payload as unknown as { hostColor?: PlayerColor };
      if (offerPayload.hostColor) {
        const next = offerPayload.hostColor === BLACK ? WHITE : BLACK;
        setMyColor(next);
        myColorRef.current = next;
      }
      setGuestOfferInput(code);

      closeScannerModal();
      showToast('成功扫描邀请码，正在生成应答码…');
      try {
        const answer = await clientRef.current?.handleGuestOffer(code, myName || '被邀请方');
        setGuestAnswerCode(answer ?? '');
        setFlow('guest-wait');
      } catch (err) {
        showToast('生成应答码失败：' + (err as Error).message);
        return false;
      }
      return true;
    }

    if (currentTarget === 'host-answer') {
      if (payload.type !== 'answer') {
        showToast('该二维码不是有效的应答码（可能是邀请码或非对局二维码）');
        return false;
      }
      setHostAnswerInput(code);
      closeScannerModal();
      showToast('成功扫描应答码，正在完成连接…');
      try {
        await clientRef.current?.finishHostConnection(code);
      } catch (err) {
        showToast('完成连接失败：' + (err as Error).message);
        return false;
      }
      return true;
    }

    return false;
  };

  /* ---------------- 暴露全局测试钩子 window.__gomoku ---------------- */

  useEffect(() => {
    (window as unknown as { __gomoku: unknown }).__gomoku = {
      get connected() { return connected; },
      get moves() { return game.moves.map((m) => ({ x: m.x, y: m.y, c: m.c })); },
      get over() { return game.over; },
      get myColor() { return myColor; },
      get peerName() { return peerName; },
      get room() { return roomCode; },
      get showMoveNumbers() { return showMoveNumbers; },
      toggleMoveNumbers: handleToggleMoveNumbers,
      toggleColor: handleToggleColor,
      get connState() { return connRef.current?.status.state ?? 'IDLE'; },
      get isPlayable() { return connRef.current?.status.isPlayable ?? false; },
      get attempt() { return connRef.current?.status.attempt ?? 0; },
      get nextRetryInMs() { return connRef.current?.status.nextRetryInMs ?? null; },
      get reason() { return connRef.current?.status.reason ?? null; },
      get label() { return connRef.current?.status.label ?? '未连接'; },
      get pcState() { return clientRef.current?.pc?.connectionState ?? 'none'; },
      get iceState() { return clientRef.current?.pc?.iceConnectionState ?? 'none'; },
      get signalingState() { return clientRef.current?.pc?.signalingState ?? 'none'; },
      get dcState() { return clientRef.current?.dc?.readyState ?? 'none'; },
      get pendingIce() { return clientRef.current?.pendingIce.length ?? 0; },
      get flow() { return flow; },
      get transport() { return transport; },
      forceConnected: (v: boolean) => {
        setManualConnected(!!v);
        if (v) setFlow('connected');
      },
      deliver: (msg: GameMessage) => handleGameMessage(msg),
      detectQrFromSource,
      handleScannedText,
      renderQrToCanvas,
      openScanner: (target: ScannerTarget) => openScannerModal(target),
      stopScanner: () => closeScannerModal(),
    };
  }, [connected, game, myColor, peerName, roomCode, flow, transport, showMoveNumbers, handleGameMessage, handleToggleMoveNumbers, handleToggleColor]);

  // 计算回合与提示信息
  const isMyTurn = currentColor(game) === myColor && swapPhaseRef.current === 'idle' && !awaitingColorRef.current;
  const turnText = !connected ? '等待连接…' : game.over ? '对局结束' : swapPhaseRef.current !== 'idle' ? '等待换边确认…' : isMyTurn ? '轮到你落子' : '对方思考中…';
  const overlayText = connected ? '' : '输入昵称，创建或加入房间，开始 P2P 对局';
  const winnerColor = game.moves[game.moves.length - 1]?.c;
  const resultText = !game.over ? '' : game.winLine
    ? winnerColor === myColor ? '你赢了（' + (winnerColor === BLACK ? '黑' : '白') + '方五连）' : '你输了，再来一局？'
    : '平局！';

  const isMeBlack = myColor === BLACK;
  const myLabel = myName ? `${myName} (我)` : isHost ? '房主 (我)' : '玩家 (我)';
  const peerLabel = peerName || (isHost ? '加入方' : '房主');
  const blackName = isMeBlack ? myLabel : peerLabel, whiteName = !isMeBlack ? myLabel : peerLabel;
  const blackTag = isMeBlack ? (isHost ? '房主 (先行)' : '加入方 (先行)') : (isHost ? '加入方 (先行)' : '房主 (先行)');
  const whiteTag = !isMeBlack ? (isHost ? '房主' : '加入方') : (isHost ? '加入方' : '房主');

  const headerStatus = connected ? 'online' : roomCode || conn.status.state !== 'IDLE' ? 'signaling' : 'offline';
  const headerStatusText = connected ? '已直连' : conn.status.state === 'IDLE' ? '未连接' : '匹配中';

  return (
    <div className={styles.layout}>
      <Header status={headerStatus} statusText={headerStatusText} />

      {/* 连接状态条：文案全部来自编排器（PRD §6.4），组件内不拼业务文案 */}
      <ConnectionBanner status={conn.status} onRetry={conn.retryNow} onLeave={conn.leave} />

      <main className={`${styles.wrap} wrap`}>
        <Board
          board={game.board}
          moves={game.moves}
          winLine={game.winLine}
          connected={boardConnected}
          turnText={turnText}
          overlayText={overlayText}
          showOverlay={!connected}
          over={game.over}
          resultText={resultText}
          soundEnabled={soundEnabled}
          myTurn={isMyTurn}
          myColor={myColor}
          canUndo={game.moves.length > 0}
          onMove={handleLocalMove}
          onUndo={handleUndo}
          onRestart={handleRestart}
          onToggleSound={() => setSoundEnabled((v) => { sounds.enabled = !v; return !v; })}
          showMoveNumbers={showMoveNumbers}
          onToggleMoveNumbers={handleToggleMoveNumbers}
          onRematch={handleRestart}
        />

        <aside className={`${styles.side} side`}>
          <ConnectionPanel
            myColor={myColor}
            isHost={isHost}
            connected={connected}
            onToggleColor={handleToggleColor}
            name={myName}
            setName={setMyName}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            flow={flow}
            roomCode={roomCode}
            inputRoomCode={inputRoomCode}
            setInputRoomCode={setInputRoomCode}
            roomStatus={conn.status.label}
            hostOfferCode={hostOfferCode}
            guestOfferInput={guestOfferInput}
            setGuestOfferInput={setGuestOfferInput}
            hostAnswerInput={hostAnswerInput}
            setHostAnswerInput={setHostAnswerInput}
            guestAnswerCode={guestAnswerCode}
            hostTimer={hostTimer}
            hostTextFolded={hostTextFolded}
            setHostTextFolded={setHostTextFolded}
            guestTextFolded={guestTextFolded}
            setGuestTextFolded={setGuestTextFolded}
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
            onCopyInviteLink={() => copyText(`${window.location.origin}/?room=${roomCode}`, '邀请链接已复制')}

            onStartHostFlow={startHostFlow}
            onStartGuestFlow={startGuestFlow}
            onCopyHostOffer={() => copyText(hostOfferCode, '邀请码已复制')}
            onCopyGuestAnswer={() => copyText(guestAnswerCode, '应答码已复制')}
            onGuestGenerateAnswer={handleGuestGenerateAnswer}
            onHostFinish={handleHostFinish}
            onOpenScanner={(target) => openScannerModal(target)}
            flowResult={flowResult}
          />

          <GameStatus
            blackName={blackName}
            whiteName={whiteName}
            blackTag={blackTag}
            whiteTag={whiteTag}
            myColor={myColor}
            moves={game.moves}
            over={game.over}
            connected={connected}
            transport={transport}
          />

          <Chat
            messages={messages}
            connected={connected}
            myName={myName}
            peerName={peerName}
            onSend={handleSendChat}
          />
        </aside>
      </main>

      <ScannerModal
        target={scannerTarget}
        onClose={closeScannerModal}
        onScan={handleScannedText}
      />

      <ConfirmModal modal={modal} />
      <Toast message={toastMessage} />
    </div>
  );
};
