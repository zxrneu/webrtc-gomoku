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
  GameMessage,
  ServerSignalingMsg,
  TransportInfo,
} from '@webrtc-gomoku/shared';
import { unpack } from '@webrtc-gomoku/shared';

import type { ChatItem, FlowState, ModalState, ScannerTarget } from './types';
import { sounds } from './audio';
import { detectQrFromSource, renderQrToCanvas } from './qr';
import { DEFAULT_ICE_SERVERS, fetchIceServers } from './iceConfig';
import { createRoomSession } from './roomSession';
import { WebRTCClient } from './webrtc';

import { Header } from './components/Header/Header';
import { Board } from './components/Board/Board';
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
  const [connected, setConnected] = useState(false);
  const [myColor, setMyColor] = useState<PlayerColor>(BLACK);
  const [myName, setMyName] = useState('');
  const [peerName, setPeerName] = useState('');
  const [isHost, setIsHost] = useState(true);

  // 界面交互状态
  const [activeTab, setActiveTab] = useState<'room' | 'manual'>('room');
  const [roomCode, setRoomCode] = useState('');
  const roomCodeRef = useRef('');
  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);
  const [inputRoomCode, setInputRoomCode] = useState('');
  const [roomStatus, setRoomStatus] = useState('');
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
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [modal, setModal] = useState<ModalState>({
    open: false,
    title: '',
    text: '',
    onOk: () => {},
    onNo: () => {},
  });

  const toastTimerRef = useRef<any>(null);
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

  // WebRTC 客户端引用
  const clientRef = useRef<WebRTCClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // 对局数据通道消息接收
  const handleGameMessage = useCallback(
    (msg: GameMessage) => {
      switch (msg.t) {
        case 'hello':
          setPeerName(msg.name || '对手');
          addSysMsg(`${msg.name || '对手'} 加入了对局`);
          break;
        case 'move':
          setGame((prevGame) => {
            const opponentColor = myColor === BLACK ? WHITE : BLACK;
            const res = applyMove(prevGame, msg.x, msg.y, opponentColor);
            if (res.ok) {
              sounds.playStone(opponentColor === BLACK);
              if (res.event === 'win') {
                sounds.playWin();
                addSysMsg(`游戏结束，${opponentColor === BLACK ? '黑方' : '白方'} 胜！`);
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
            {
              id: Math.random().toString(36).slice(2),
              sender: 'peer',
              text: msg.text,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ]);
          sounds.playNotify();
          break;
        case 'undo-req':
          setModal({
            open: true,
            title: '对方申请悔棋',
            text: '对手希望能撤回最后一手，是否同意？',
            onOk: () => {
              setModal((m) => ({ ...m, open: false }));
              setGame((g) => {
                undoMove(g);
                return { ...g };
              });
              clientRef.current?.sendMessage({ t: 'undo-ok' });
              addSysMsg('你同意了对方的悔棋申请');
            },
            onNo: () => {
              setModal((m) => ({ ...m, open: false }));
              clientRef.current?.sendMessage({ t: 'undo-no' });
              addSysMsg('你拒绝了对方的悔棋申请');
            },
          });
          break;
        case 'undo-ok':
          setGame((g) => {
            undoMove(g);
            return { ...g };
          });
          showToast('对方同意了悔棋');
          addSysMsg('对方同意了悔棋申请');
          break;
        case 'undo-no':
          showToast('对方拒绝了悔棋申请');
          addSysMsg('对方拒绝了悔棋申请');
          break;
        case 'restart-req':
          setModal({
            open: true,
            title: '对方申请重新开始',
            text: '对手希望能重开一局，是否同意？',
            onOk: () => {
              setModal((m) => ({ ...m, open: false }));
              setGame(createGame());
              clientRef.current?.sendMessage({ t: 'restart-ok' });
              addSysMsg('对局已重新开始');
            },
            onNo: () => {
              setModal((m) => ({ ...m, open: false }));
              clientRef.current?.sendMessage({ t: 'restart-no' });
              addSysMsg('你拒绝了对方的重开申请');
            },
          });
          break;
        case 'restart-ok':
          setGame(createGame());
          showToast('对方同意重开一局');
          addSysMsg('对局已重新开始');
          break;
        case 'restart-no':
          showToast('对方拒绝了重开申请');
          addSysMsg('对方拒绝了重开申请');
          break;
        case 'bye':
          setConnected(false);
          addSysMsg('对方退出了对局');
          showToast('对方已断开连接');
          break;
      }
    },
    [myColor, addSysMsg, showToast]
  );

  const myNameRef = useRef(myName);
  myNameRef.current = myName;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const handleGameMessageRef = useRef(handleGameMessage);
  handleGameMessageRef.current = handleGameMessage;

  // 初始化 WebRTC 客户端（仅在组件挂载时初始化一次，避免因 state 变更重建导致连接被析构）
  useEffect(() => {
    const client = new WebRTCClient({
      // 初始兜底：保证建连前 iceServers 永不为未初始化状态
      iceServers: DEFAULT_ICE_SERVERS,
      onMessage: (msg) => handleGameMessageRef.current(msg),
      onConnected: () => {
        setConnected(true);
        setFlow('connected');
        showToast('P2P 连接已建立！');
        addSysMsg('P2P 直连已建立，开始对局！');
        sounds.playNotify();
        client.sendMessage({ t: 'hello', name: myNameRef.current || (isHostRef.current ? '房主' : '玩家') });
      },
      onDisconnected: () => {
        setConnected(false);
        setTransport(null);
      },
      onTransportUpdate: (info) => {
        setTransport(info);
      },
      onStateChange: () => {},
    });
    clientRef.current = client;

    // 异步拉取服务端下发的 ICE 配置；失败自动降级为内置 STUN，
    // 绝不阻塞/破坏对局——零服务器（微信互发连接码）保底路径不受影响。
    let cancelled = false;
    fetchIceServers()
      .then((servers) => {
        if (!cancelled) client.setIceServers(servers);
      })
      .catch(() => {
        // fetchIceServers 契约上永不 reject，此处仅为防御性兜底。
      });

    return () => {
      cancelled = true;
      client.close();
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // 本地落子逻辑
  const handleLocalMove = useCallback(
    (x: number, y: number) => {
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
        clientRef.current?.sendMessage({ t: 'move', x, y });

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
    if (!connected || game.over || game.moves.length === 0) return;
    clientRef.current?.sendMessage({ t: 'undo-req' });
    showToast('已发送悔棋申请，等待对方同意…');
  }, [connected, game.over, game.moves.length, showToast]);

  // 重开操作
  const handleRestart = useCallback(() => {
    if (!connected) return;
    clientRef.current?.sendMessage({ t: 'restart-req' });
    showToast('已发送重新开始申请，等待对方同意…');
  }, [connected, showToast]);

  // 聊天发送
  const handleSendChat = useCallback(
    (text: string) => {
      if (!connected || !text.trim()) return;
      clientRef.current?.sendMessage({ t: 'chat', text });
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
    setMyColor(BLACK);
    setFlow('host-wait');
    try {
      const offer = await clientRef.current.createHostOffer(myName || '房主');
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
  const wsQueueRef = useRef<any[]>([]);
  const diagTimerRef = useRef<any>(null);
  const [flowResult, setFlowResult] = useState<{ type: string; html: string } | null>(null);

  /**
   * 复位房间会话：换房（创建/加入房间）或对手离开时调用。
   * 关闭旧 P2P 连接并清空全部房间级 state，
   * 杜绝上一房间的棋盘、聊天、对手昵称、连接状态与弹窗残留到下一房间。
   */
  const resetRoomSession = useCallback(() => {
    const fresh = createRoomSession();
    clientRef.current?.close();
    setGame(fresh.game);
    setMessages(fresh.messages);
    setPeerName(fresh.peerName);
    setConnected(fresh.connected);
    setTransport(fresh.transport);
    setRoomStatus(fresh.roomStatus);
    setFlow(fresh.flow);
    setHostOfferCode(fresh.hostOfferCode);
    setGuestOfferInput(fresh.guestOfferInput);
    setHostAnswerInput(fresh.hostAnswerInput);
    setGuestAnswerCode(fresh.guestAnswerCode);
    setHostTimer(fresh.hostTimer);
    setFlowResult(fresh.flowResult);
    setModal(fresh.modal);
  }, []);

  useEffect(() => {
    connectedRef.current = connected;
    if (connected) {
      if (diagTimerRef.current) clearTimeout(diagTimerRef.current);
      setFlowResult({
        type: 'ok',
        html: '<b>✅ 连接成功</b><br>对局数据通过浏览器 P2P DataChannel 直传',
      });
      const el = document.getElementById('flow-result');
      if (el) {
        el.className = 'flow-result ok';
        el.innerHTML = '<b>✅ 连接成功</b><br>对局数据通过浏览器 P2P DataChannel 直传';
        el.classList.remove('hidden');
        el.style.display = 'block';
      }
    }
  }, [connected]);

  const diagnoseFailure = useCallback(() => {
    if (diagTimerRef.current) clearTimeout(diagTimerRef.current);
    const items = [
      '双方已交换候选但仍无法互通：可能处于对称型 NAT 或企业防火墙后',
      '可尝试：双方都切到手机热点；或自建/租用 TURN 服务器兜底',
    ];
    const html =
      '<b>⚠️ 连接失败</b><ul>' + items.map((i) => '<li>' + i + '</li>').join('') + '</ul>';
    setFlowResult({
      type: 'bad',
      html,
    });
    const el = document.getElementById('flow-result');
    if (el) {
      el.className = 'flow-result bad';
      el.innerHTML = html;
      el.classList.remove('hidden');
      el.style.display = 'block';
    }
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
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(tip)).catch(() => {
        showToast('请手动全选复制');
      });
    } else {
      showToast('复制成功');
    }
  };

  const signalSend = useCallback((obj: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj));
    } else {
      wsQueueRef.current.push(obj);
    }
  }, []);

  /* ---------------- 房间联机 WebSocket 流程 ---------------- */

  const ensureWsSignaling = useCallback(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.CONNECTING || wsRef.current.readyState === WebSocket.OPEN)
    ) {
      return wsRef.current;
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/signal`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      const q = wsQueueRef.current;
      wsQueueRef.current = [];
      q.forEach((m) => ws.send(JSON.stringify(m)));
    };

    ws.onmessage = async (e) => {
      let msg: ServerSignalingMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg.t === 'created') {
        resetRoomSession();
        setRoomCode(msg.room);
        roomCodeRef.current = msg.room;
        setRoomStatus('等待对手加入…');
        setIsHost(true);
        setMyColor(BLACK);
        showToast(`房间 ${msg.room} 创建成功`);
      } else if (msg.t === 'joined') {
        resetRoomSession();
        setRoomCode(msg.room);
        roomCodeRef.current = msg.room;
        setRoomStatus('已加入房间，等待对手连接…');
        setIsHost(false);
        setMyColor(WHITE);
        showToast(`已加入房间 ${msg.room}`);
      } else if (msg.t === 'peer-joined') {
        setRoomStatus(`玩家 ${msg.name || '对手'} 已加入，正在建立 P2P…`);
        if (clientRef.current) {
          const pc = clientRef.current.initPeer(true);
          pc.onicecandidate = (ev) => {
            if (ev.candidate) {
              signalSend({
                t: 'signal',
                room: roomCodeRef.current,
                data: {
                  kind: 'ice',
                  candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
                },
              });
            }
          };
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          signalSend({
            t: 'signal',
            room: roomCodeRef.current,
            data: { kind: 'offer', sdp: pc.localDescription },
          });
        }
      } else if (msg.t === 'peer-left') {
        // 对手离开：清空上一局的棋盘/聊天/连接与对手信息，但保留房间号等待新对手
        resetRoomSession();
        setRoomStatus('对手已离开，等待新对手加入…');
        addSysMsg('对手已离开房间');
        showToast('对手已离开房间');
      } else if (msg.t === 'signal' && msg.data) {
        const data = msg.data as any;
        const pc = clientRef.current?.pc;
        if (data.kind === 'offer') {
          const guestPc = clientRef.current?.initPeer(false)!;
          guestPc.onicecandidate = (ev) => {
            if (ev.candidate) {
              signalSend({
                t: 'signal',
                room: roomCodeRef.current,
                data: {
                  kind: 'ice',
                  candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
                },
              });
            }
          };
          await guestPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          for (const cand of clientRef.current?.pendingIce || []) {
            try {
              await guestPc.addIceCandidate(cand);
            } catch {}
          }
          clientRef.current!.pendingIce = [];
          const answer = await guestPc.createAnswer();
          await guestPc.setLocalDescription(answer);
          signalSend({
            t: 'signal',
            room: roomCodeRef.current,
            data: { kind: 'answer', sdp: guestPc.localDescription },
          });
        } else if (data.kind === 'answer' && pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          for (const cand of clientRef.current?.pendingIce || []) {
            try {
              await pc.addIceCandidate(cand);
            } catch {}
          }
          clientRef.current!.pendingIce = [];
        } else if (data.kind === 'ice') {
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch {}
          } else if (clientRef.current) {
            clientRef.current.pendingIce.push(data.candidate);
          }
        }
      } else if (msg.t === 'error') {
        showToast(msg.message);
      }
    };

    return ws;
  }, [showToast, signalSend, resetRoomSession, addSysMsg]);

  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      (window.location.protocol === 'http:' || window.location.protocol === 'https:')
    ) {
      ensureWsSignaling();
    }
  }, [ensureWsSignaling]);

  const handleCreateRoom = () => {
    const ws = ensureWsSignaling();
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'create', room: code }));
    } else {
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'create', room: code }));
      };
    }
  };

  const handleJoinRoom = () => {
    const code = inputRoomCode.trim().toUpperCase();
    if (!code) {
      alert('请输入4位房间号');
      return;
    }
    const ws = ensureWsSignaling();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'join', room: code, name: myName }));
    } else {
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', room: code, name: myName }));
      };
    }
  };

  /* ---------------- 扫码识别处理 ---------------- */

  const scannerTargetRef = useRef<ScannerTarget>(null);

  const openScannerModal = (target: ScannerTarget) => {
    scannerTargetRef.current = target;
    const mask = document.getElementById('scanner-mask');
    if (mask) {
      mask.classList.remove('hidden');
      mask.style.display = 'flex';
    }
    const titleEl = document.getElementById('scanner-title');
    if (titleEl) {
      titleEl.textContent =
        target === 'guest-offer'
          ? '扫描邀请码'
          : target === 'host-answer'
          ? '扫描应答码'
          : '扫描对局二维码';
    }
    setScannerTarget(target);
  };

  const closeScannerModal = () => {
    scannerTargetRef.current = null;
    const mask = document.getElementById('scanner-mask');
    if (mask) {
      mask.classList.add('hidden');
      mask.style.display = 'none';
    }
    setScannerTarget(null);
  };

  const handleScannedText = async (text: string) => {
    if (!text || !text.trim()) return false;
    let payload: any;
    try {
      payload = await unpack(text.trim());
    } catch {
      showToast('该二维码不是有效的五子棋对局二维码');
      return false;
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
      const inEl = document.getElementById('flow-guest-in') as HTMLTextAreaElement;
      if (inEl) inEl.value = text.trim();
      setGuestOfferInput(text.trim());
      closeScannerModal();
      showToast('成功扫描邀请码，正在生成应答码…');
      if (clientRef.current) {
        try {
          const answer = await clientRef.current.handleGuestOffer(
            text.trim(),
            myName || '被邀请方'
          );
          const outEl = document.getElementById('flow-guest-out') as HTMLTextAreaElement;
          if (outEl) outEl.value = answer;
          setGuestAnswerCode(answer);
          setFlow('guest-wait');
        } catch (err) {
          showToast('生成应答码失败：' + (err as Error).message);
          return false;
        }
      }
      return true;
    } else if (currentTarget === 'host-answer') {
      if (payload.type !== 'answer') {
        showToast('该二维码不是有效的应答码（可能是邀请码或非对局二维码）');
        return false;
      }
      const inEl = document.getElementById('flow-host-in') as HTMLTextAreaElement;
      if (inEl) inEl.value = text.trim();
      setHostAnswerInput(text.trim());
      closeScannerModal();
      showToast('成功扫描应答码，正在完成连接…');
      if (clientRef.current) {
        try {
          await clientRef.current.finishHostConnection(text.trim());
        } catch (err) {
          showToast('完成连接失败：' + (err as Error).message);
          return false;
        }
      }
      return true;
    }
    return false;
  };

  /* ---------------- 暴露全局测试钩子 window.__gomoku ---------------- */

  useEffect(() => {
    (window as unknown as { __gomoku: any }).__gomoku = {
      get connected() {
        return connected;
      },
      get moves() {
        return game.moves.map((m) => ({ x: m.x, y: m.y, c: m.c }));
      },
      get over() {
        return game.over;
      },
      get myColor() {
        return myColor;
      },
      get peerName() {
        return peerName;
      },
      get room() {
        return roomCode;
      },
      get pcState() {
        return clientRef.current?.pc ? clientRef.current.pc.connectionState : 'none';
      },
      get iceState() {
        return clientRef.current?.pc ? clientRef.current.pc.iceConnectionState : 'none';
      },
      get signalingState() {
        return clientRef.current?.pc ? clientRef.current.pc.signalingState : 'none';
      },
      get dcState() {
        return clientRef.current?.dc ? clientRef.current.dc.readyState : 'none';
      },
      get pendingIce() {
        return clientRef.current?.pendingIce.length || 0;
      },
      get flow() {
        return flow;
      },
      get transport() {
        return transport;
      },
      forceConnected: (v: boolean) => {
        setConnected(!!v);
        if (v) setFlow('connected');
      },
      deliver: (msg: GameMessage) => handleGameMessage(msg),
      detectQrFromSource,
      handleScannedText,
      renderQrToCanvas,
      openScanner: (t: ScannerTarget) => openScannerModal(t),
      stopScanner: () => closeScannerModal(),
    };
  }, [connected, game, myColor, peerName, roomCode, flow, transport, handleGameMessage]);

  // 计算回合与提示信息
  const isMyTurn = currentColor(game) === myColor;
  const currentTurnColor = currentColor(game);
  const turnText = !connected
    ? '等待连接…'
    : game.over
    ? '对局结束'
    : isMyTurn
    ? '轮到你落子'
    : '对方思考中…';

  const overlayText = connected
    ? ''
    : '输入昵称，创建或加入房间，开始 P2P 对局';

  const winnerColor = game.moves[game.moves.length - 1]?.c;
  const resultText = !game.over
    ? ''
    : game.winLine
    ? winnerColor === myColor
      ? '你赢了（' + (winnerColor === BLACK ? '黑' : '白') + '方五连）'
      : '你输了，再来一局？'
    : '平局！';

  const headerStatus = connected ? 'online' : roomCode ? 'signaling' : 'offline';
  const headerStatusText = connected ? '已直连' : roomCode ? '匹配中' : '未连接';

  return (
    <div className={styles.layout}>
      <Header status={headerStatus} statusText={headerStatusText} />

      <main className={`${styles.wrap} wrap`}>
        <Board
          board={game.board}
          moves={game.moves}
          winLine={game.winLine}
          connected={connected}
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
          onToggleSound={() => {
            setSoundEnabled((v) => {
              sounds.enabled = !v;
              return !v;
            });
          }}
          onRematch={() => {
            handleRestart();
          }}
        />

        <aside className={`${styles.side} side`}>
          <ConnectionPanel
            name={myName}
            setName={setMyName}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            flow={flow}
            roomCode={roomCode}
            inputRoomCode={inputRoomCode}
            setInputRoomCode={setInputRoomCode}
            roomStatus={roomStatus}
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
            onCopyInviteLink={() => {
              const url = `${window.location.origin}/?room=${roomCode}`;
              copyText(url, '邀请链接已复制');
            }}
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
            blackName={isHost ? myName || '黑方 (我)' : peerName || '黑方'}
            whiteName={!isHost ? myName || '白方 (我)' : peerName || '白方'}
            blackTag={isHost ? '邀请方 (先行)' : '加入方 (先行)'}
            whiteTag={!isHost ? '加入方' : '邀请方'}
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
