/**
 * ============================================================================
 * 连接编排的 React 适配层（`useConnection`）
 * ============================================================================
 * 本文件是**唯一**把浏览器能力（WebSocket / RTCPeerConnection / DOM 事件）
 * 注入给 `shared` 编排器的地方。职责严格限定为「接线」，不含任何重连判断逻辑：
 *
 * ```
 *  React 组件  ←  useConnection  ←  ConnectionManager（shared，纯逻辑）
 *                    ↑                    ↑
 *              wsTransport          p2pTransport
 *             （WebSocket）        （WebRTCClient）
 * ```
 *
 * 设计约束（architecture.md §3 / ADR-9）：
 * - 组件里只允许读 `status`，**禁止**再散落 `connected` / `roomStatus` 之类的镜像状态；
 * - 所有定时器都由注入的 `Clock` 创建，组件卸载时 `manager.dispose()` 一并清理；
 * - 日志只有一个出口（`logger.ts`），本文件不打印任何东西。
 */

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BLACK, type Move, type PlayerColor } from '@webrtc-gomoku/core';
import type {
  Clock,
  ConnSideEffect,
  ConnectionManager,
  ConnectionStatus,
  GameMessage,
  Logger,
  P2pTransport,
  TransportInfo,
} from '@webrtc-gomoku/shared';
import {
  DEFAULT_POLICY,
  createConnectionManager,
  deriveStatus,
  initialSnapshot,
} from '@webrtc-gomoku/shared';

import { LobbyContext } from '../lobby/LobbyProvider';
import { DEFAULT_ICE_SERVERS, fetchIceServers } from '../iceConfig';
import { WebRTCClient } from '../webrtc';

import { createDiagnosticSink, createLogger } from './logger';
import { createP2pTransport } from './p2pTransport';
import { createWsTransport } from './wsTransport';

/** 状态倒计时刷新间隔（只在需要倒计时时才启动） */
const TICK_MS = 500;

/** 系统时钟：`Clock` 的浏览器实现（唯一允许直接碰 `Date.now/setTimeout` 的 web 文件） */
function createSystemClock(): Clock {
  return {
    now: (): number => Date.now(),
    setTimeout: (fn: () => void, ms: number): number =>
      globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (handle: number): void => {
      globalThis.clearTimeout(handle);
    },
  };
}

/** 解析信令 URL（`shared` 不知道 location，必须由 web 提供） */
function resolveSignalUrl(): string {
  if (typeof window === 'undefined' || !window.location) return 'ws://localhost:3000/signal';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/signal`;
}

/** 当前是否在线（SSR / 单测环境下按在线处理） */
function readOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

/** `useConnection` 的入参：全部是「业务层关心的事」，不含连接细节 */
export interface UseConnectionOptions {
  getLocalColor?: () => PlayerColor;
  onColorRestored?: (color: PlayerColor) => void;
  /** 收到一条非控制类局内消息（落子 / 聊天 / 悔棋…） */
  onGameMessage: (msg: GameMessage) => void;
  /** 编排器副作用（toast / 系统消息 / 按钮） */
  onEvent: (e: ConnSideEffect) => void;
  /** 取本地棋谱快照（恢复后对账用） */
  getLocalMoves: () => readonly Move[];
  /** 对账后要求业务层重放棋盘（加入方） */
  onMovesReplaced: (moves: readonly Move[]) => void;
  /** 网络质量指标更新（RTT / 候选类型） */
  onTransportUpdate?: (info: TransportInfo | null) => void;
  /**
   * 底层 DataChannel 首次打开。
   *
   * 只服务于「手动邀请码」零服务器模式（该模式不经过编排器，状态机保持 IDLE）；
   * 房间模式请改用 `onEvent({ type:'connected' })`，否则会与编排器重复触发。
   */
  onP2pConnected?: () => void;
  /** 底层 DataChannel 关闭 / PC 断开（同样只服务于手动邀请码模式） */
  onP2pDisconnected?: () => void;
}

/** 业务层可用的连接 API */
export interface ConnectionApi {
  /** 唯一状态源（8 状态 + 文案 + 倒计时） */
  status: ConnectionStatus;
  /** 底层 WebRTC 客户端（仅「手动邀请码」零服务器模式需要） */
  client: WebRTCClient | null;
  /** 创建房间（房主，恒为 offerer） */
  createRoom(code: string, name?: string): void;
  /** 加入房间（加入方，只应答） */
  joinRoom(code: string, name: string): void;
  /** 立即重试 */
  retryNow(): void;
  /** 主动离开 */
  leave(): void;
  /** 发送一条局内消息；返回 DC 是否就绪（false 必须让用户可见） */
  send(msg: GameMessage): boolean;
  /** 落子后探测 DC（R9） */
  notifyLocalMove(): void;
  /** 对手主动 bye → 视为对手已离开 */
  notifyPeerGone(): void;
}

/**
 * 创建并托管连接编排器。
 *
 * 组件只需 `const conn = useConnection({...})`，然后读 `conn.status`。
 *
 * @param options 业务回调（通过 ref 转发，保证编排器永远拿到最新闭包）
 * @returns 稳定的连接 API
 */
export function useConnection(options: UseConnectionOptions): ConnectionApi {
  const lobby = __LOBBY_ENABLED__ ? useContext(LobbyContext) : null;
  const lobbyRef = __LOBBY_ENABLED__ ? useRef(lobby) : null;
  if (lobbyRef) lobbyRef.current = lobby;
  const [status, setStatus] = useState<ConnectionStatus>(() => {
    const now = Date.now();
    return deriveStatus(initialSnapshot(now), DEFAULT_POLICY, now);
  });
  const [client, setClient] = useState<WebRTCClient | null>(null);

  const managerRef = useRef<ConnectionManager | null>(null);
  const p2pRef = useRef<P2pTransport | null>(null);
  const optionsRef = useRef<UseConnectionOptions>(options);

  // 每次渲染同步最新回调：编排器在定时器里调用时也能拿到最新闭包
  useEffect(() => {
    optionsRef.current = options;
    lobbyRef?.current?.persist(options.getLocalMoves(), options.getLocalColor?.() ?? BLACK);
  });

  useEffect(() => {
    const clock = createSystemClock();
    const logger: Logger = createLogger({ enabled: true });

    const webrtc = new WebRTCClient({
      iceServers: DEFAULT_ICE_SERVERS,
      // 房间模式：DC 消息统一经 P2pTransport 事件通道交给编排器
      //（编排器负责拦截 ping/pong/sync），此处必须保持静默，否则会重复投递。
      onMessage: (): void => {},
      onConnected: (): void => {
        optionsRef.current.onP2pConnected?.();
      },
      onDisconnected: (): void => {
        optionsRef.current.onP2pDisconnected?.();
      },
      onTransportUpdate: (info): void => {
        optionsRef.current.onTransportUpdate?.(info);
      },
      onDiagnostic: createDiagnosticSink(),
    });

    const rawSignal = createWsTransport({ clock, policy: DEFAULT_POLICY });
    const signal = lobbyRef?.current?.runtime.attach(rawSignal) ?? rawSignal;
    const p2p = createP2pTransport({
      clock,
      policy: DEFAULT_POLICY,
      client: webrtc,
      signalOut: (data): void => {
        // 房间号由服务端按连接归属判定，客户端不需要（也不应该）重复声明
        signal.send({ t: 'signal', data });
      },
    });

    const manager = createConnectionManager({
      signal,
      p2p,
      clock,
      random: Math.random,
      policy: DEFAULT_POLICY,
      logger,
      signalUrl: resolveSignalUrl(),
      getLocalMoves: () => optionsRef.current.getLocalMoves(),
      onMovesReplaced: (moves) => optionsRef.current.onMovesReplaced(moves),
      onStatus: (s): void => setStatus(s),
      onEvent: (e): void => optionsRef.current.onEvent(e),
      onGameMessage: (msg): void => optionsRef.current.onGameMessage(msg),
      isOnline: readOnline,
    });

    lobbyRef?.current?.bind(manager, (moves, color) => {
      optionsRef.current.onMovesReplaced(moves);
      optionsRef.current.onColorRestored?.(color);
    });
    managerRef.current = manager;
    p2pRef.current = p2p;
    setClient(webrtc);
    setStatus(manager.getStatus());

    // 异步拉取服务端下发的 ICE 配置；失败降级为内置 STUN（绝不阻塞对局）
    let cancelled = false;
    fetchIceServers()
      .then((servers) => {
        if (!cancelled) webrtc.setIceServers(servers);
      })
      .catch(() => {
        /* fetchIceServers 契约上永不 reject，此处仅防御性兜底 */
      });

    // L4：页面隐藏 = 修饰符 paused（不消耗重试次数），回到可见立刻补一次重试
    const onVisibility = (): void => {
      manager.setPageVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibility);

    // 网络恢复：立刻重试（编排器对非法状态会自动忽略，不会误改状态机）
    const onOnline = (): void => {
      manager.retryNow();
    };
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      lobbyRef?.current?.runtime.dispose();
      manager.dispose();
      managerRef.current = null;
      p2pRef.current = null;
    };
  }, []);

  // 只有「重连倒计时 / 对手宽限倒计时」存在时才需要按帧刷新文案
  const needsTick = status.state === 'RECONNECTING' || status.peerOfflineInMs !== null;
  useEffect(() => {
    if (!needsTick) return;
    const id = window.setInterval(() => {
      const manager = managerRef.current;
      if (manager) setStatus(manager.getStatus());
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [needsTick]);

  return useMemo<ConnectionApi>(
    () => ({
      status,
      client,
      createRoom: (code: string, name?: string): void => {
        managerRef.current?.createRoom(code, name);
      },
      joinRoom: (code: string, name: string): void => {
        managerRef.current?.joinRoom(code, name);
      },
      retryNow: (): void => {
        managerRef.current?.retryNow();
      },
      leave: (): void => {
        managerRef.current?.leave();
      },
      send: (msg: GameMessage): boolean => p2pRef.current?.send(msg) ?? false,
      notifyLocalMove: (): void => {
        managerRef.current?.notifyLocalMove();
      },
      notifyPeerGone: (): void => {
        managerRef.current?.notifyPeerGone();
      },
    }),
    [status, client]
  );
}
