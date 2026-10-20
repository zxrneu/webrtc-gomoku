import React, { createContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BLACK, WHITE, type Move, type PlayerColor } from '@webrtc-gomoku/core';
import type { ConnectionManager, LobbySeat } from '@webrtc-gomoku/shared';
import { createLobbyRuntime, type LobbyRuntime, type LobbyView } from './runtime';
import { createLobbyId, lobbyIdentity, prepareLobbyWindow, readLobbySession, saveLobbySession } from './storage';
import { isLobbyName } from '@webrtc-gomoku/shared';
import { LobbyPage } from './LobbyPage';
import type { GameMode } from '../types';
import styles from './Lobby.module.css';

interface LobbyContextValue {
  openLobby: () => void;
  openGame: (mode?: GameMode) => void;
  runtime: LobbyRuntime;
  view: LobbyView;
  now: number;
  retry: () => void;
  bind: (manager: ConnectionManager, restore: (moves: readonly Move[], color: PlayerColor) => void) => void;
  persist: (moves: readonly Move[], color: PlayerColor) => void;
  leave: () => void;
}
export const LobbyContext = /* @__PURE__ */ createContext<LobbyContextValue | null>(null);

function safeStore(kind: 'localStorage' | 'sessionStorage'): Storage {
  try { return window[kind]; } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 };
  }
}

/** 仅在线构建挂载：维护浏览器能力发现、窗口凭证和大厅视图。 */
export function LobbyProvider({ children }: { children: React.ReactNode }) {
  const manager = useRef<ConnectionManager | null>(null);
  const restore = useRef<(moves: readonly Move[], color: PlayerColor) => void>(() => {});
  const [session] = useState(() => {
    const store = safeStore('sessionStorage');
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    prepareLobbyWindow(store, { hasOpener: !!window.opener, navigationType: navigation?.type });
    return store;
  });
  const [local] = useState(() => safeStore('localStorage'));
  const [saved] = useState(() => readLobbySession(session));
  const seat = useRef<LobbySeat | null>(saved?.seat ?? null);
  const moves = useRef<readonly Move[]>(saved?.moves ?? []);
  const color = useRef<PlayerColor>(saved?.myColor ?? (saved?.seat.role === 'guest' ? WHITE : BLACK));
  const restored = useRef(!saved);
  const [page, setPage] = useState<'lobby' | 'game'>(() => location.pathname !== '/lobby' && (saved || new URLSearchParams(location.search).has('room')) ? 'game' : 'lobby');
  const navigate = (next: 'lobby' | 'game') => { setPage(next); history.pushState({}, '', next === 'lobby' ? '/lobby' : '/'); };
  const nameRef = useRef(saved?.name ?? '棋友');
  const [runtime] = useState(() => {
    const identity = lobbyIdentity(local, session, () => createLobbyId(bytes => crypto.getRandomValues(bytes)));
    let name = saved?.name ?? `棋友${identity.tabId.replace(/-/g, '').slice(0, 4)}`;
    try { const cached = local.getItem('gomoku:lobby-name'); if (isLobbyName(cached)) name = cached; } catch { /* 临时昵称 */ }
    return createLobbyRuntime({ ...identity, name, url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`,
      clock: { now: Date.now, setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: handle => window.clearTimeout(handle) },
      restoreSeat: saved?.seat,
      onSeat: value => {
        const hadSeat = !!seat.current;
        const changedRoom = seat.current?.room !== value?.room;
        seat.current = value;
        if (value && changedRoom) { navigate('game'); window.setTimeout(() => document.getElementById('mode-online-btn')?.click(), 0); }
        if (!value) {
          moves.current = []; restored.current = true; saveLobbySession(session, null);
          if (hadSeat) navigate('lobby');
        }
        else saveLobbySession(session, { seat: value, moves: [...moves.current], name: nameRef.current, myColor: color.current });
      },
      onRestored: () => { restore.current(saved?.moves ?? [], color.current); restored.current = true; },
    });
  });
  const view = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const requestedRoom = useRef(new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '');
  useEffect(() => {
    const code = requestedRoom.current;
    if (saved || view.phase !== 'ready' || !/^[A-Z0-9]{4}$/.test(code) || !manager.current) return;
    requestedRoom.current = '';
    manager.current.joinRoom(code, view.name);
  }, [view.phase, view.name, saved]);
  nameRef.current = view.name;
  const [now, setNow] = useState(Date.now);
  const [attempt, setAttempt] = useState(0);
  const [configError, setConfigError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    setConfigError(false);
    fetch('/config', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('config');
      const data: unknown = await response.json();
      const supported = !!data && typeof data === 'object' && 'capabilities' in data && !!data.capabilities &&
        typeof data.capabilities === 'object' && 'lobby' in data.capabilities && data.capabilities.lobby === true;
      if (active) runtime.enable(supported);
    }).catch(() => { if (active) setConfigError(true); }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [runtime, attempt]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { try { local.setItem('gomoku:lobby-name', view.name); } catch { /* 临时昵称 */ } }, [view.name, local]);
  useEffect(() => {
    const pop = () => setPage(location.pathname === '/lobby' ? 'lobby' : 'game');
    window.addEventListener('popstate', pop);
    if (page === 'lobby') history.replaceState({}, '', '/lobby');
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const openLobby = () => navigate('lobby');
  const openGame = (mode: GameMode = 'online') => {
    navigate('game');
    window.setTimeout(() => document.getElementById(`mode-${mode}-btn`)?.click(), 0);
  };
  const value: LobbyContextValue = {
    openLobby, openGame, runtime, view: configError ? { ...view, phase: 'offline', notice: '暂时无法连接大厅服务，请重试' } : view, now,
    retry: () => { if (configError) setAttempt(v => v + 1); else runtime.retry(); },
    bind: (connection, callback) => { manager.current = connection; restore.current = callback; runtime.ready(connection); },
    persist: (current, myColor) => {
      if (!restored.current || !seat.current || manager.current?.getStatus().room !== seat.current.room) return;
      moves.current = current;
      color.current = myColor;
      saveLobbySession(session, { seat: seat.current, moves: [...current], name: view.name, myColor });
    },
    leave: () => { manager.current?.leave(); runtime.send({ t: 'lobby-list' }); },
  };
  const incoming = view.state?.invite && view.state.invite.to.id === view.state.selfId;
  return <LobbyContext.Provider value={value}>
    <div hidden={page === 'lobby'}>{children}</div>
    {page === 'lobby' && <LobbyPage />}
    {incoming && page !== 'lobby' && <button className={styles.globalNotice} onClick={openLobby} aria-live="polite">
      {view.state?.invite?.from.name} 邀请你对弈 · 查看邀请
    </button>}
  </LobbyContext.Provider>;
}
