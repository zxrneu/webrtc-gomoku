import { decodeLobbyServer, type ClientLobbyMsg, type ConnectionManager, type Clock, type LobbySeat,
  type LobbyState, type SignalEvent, type SignalTransport } from '@webrtc-gomoku/shared';

export interface LobbyView {
  phase: 'loading' | 'ready' | 'offline' | 'unsupported';
  state: LobbyState | null;
  pending: boolean;
  notice: string;
  name: string;
}
interface Options {
  clock: Clock;
  name: string;
  browserId: string;
  tabId: string;
  url: string;
  onSeat?: (seat: LobbySeat | null) => void;
  restoreSeat?: LobbySeat | null;
  onRestored?: () => void;
}

/** 在同一条信令连接上隔离大厅事件，入座后交还既有连接编排器。 */
export function createLobbyRuntime(options: Options) {
  let view: LobbyView = { phase: 'loading', state: null, pending: false, notice: '', name: options.name };
  let raw: SignalTransport | null = null;
  let manager: ConnectionManager | null = null;
  let gameEvent: ((event: SignalEvent) => void) | null = null;
  let enabled = false;
  let disposed = false;
  let assigned: LobbySeat | null = null;
  let restoreSeat = options.restoreSeat ?? null;
  let currentSeat: LobbySeat | null = null;
  let cancelled = false;
  let retryTimer: number | null = null;
  let pendingTimer: number | null = null;
  let pollTimer: number | null = null;
  let attempts = 0;
  let mustReconnect = false;
  let query: Extract<ClientLobbyMsg, { t: 'lobby-list' }> = { t: 'lobby-list' };
  const listeners = new Set<() => void>();
  const clock = options.clock;
  const clear = (timer: number | null) => { if (timer !== null) clock.clearTimeout(timer); return null; };
  function update(patch: Partial<LobbyView>): void {
    view = { ...view, ...patch }; for (const listener of listeners) listener();
  }
  function settle(): void { pendingTimer = clear(pendingTimer); update({ pending: false }); }
  function enter(): void {
    if (!enabled) return;
    pollTimer = clear(pollTimer);
    update({ phase: 'loading', state: null });
    raw?.send({ t: 'lobby-enter', name: view.name, browserId: options.browserId, tabId: options.tabId });
  }
  function connect(): void {
    if (!raw || disposed || !enabled) return;
    retryTimer = clear(retryTimer);
    if (raw.readyState === 'open' && !mustReconnect) enter();
    else if (mustReconnect || raw.readyState !== 'connecting') { mustReconnect = false; raw.connect(options.url, 8000); }
  }
  function poll(): void {
    pollTimer = clear(pollTimer);
    if (!enabled || disposed || view.phase !== 'ready') return;
    pollTimer = clock.setTimeout(() => {
      pollTimer = null;
      if (view.phase === 'ready' && raw?.readyState === 'open') raw.send(query);
      poll();
    }, 5000);
  }
  function lost(): void {
    mustReconnect = true;
    pendingTimer = clear(pendingTimer);
    update({ phase: 'offline', pending: false, state: null, notice: '大厅连接已断开，正在尝试恢复' });
    if (manager?.getStatus().state !== 'IDLE' || attempts >= 5) return;
    retryTimer = clear(retryTimer);
    retryTimer = clock.setTimeout(() => { attempts++; connect(); }, Math.min(2000 * 2 ** attempts, 10000));
  }
  function adopt(seat: LobbySeat): void {
    if (manager?.getStatus().room === seat.room && manager.getStatus().state !== 'IDLE') return;
    if (cancelled || !manager || manager.getStatus().state !== 'IDLE') {
      raw?.send({ t: 'leave' }); settle(); return;
    }
    assigned = seat; currentSeat = seat; options.onSeat?.(seat);
    settle(); update({ notice: seat.role === 'host' ? '房间已就位，等待对手连接…' : '对方已就位，正在建立连接…' });
    if (seat.role === 'host') manager.createRoom(seat.room, view.name);
    else manager.joinRoom(seat.room, view.name);
  }
  function serverMessage(event: Extract<SignalEvent, { type: 'msg' }>): boolean {
    if (!event.msg.t.startsWith('lobby-')) return false;
    const msg = decodeLobbyServer(event.msg);
    if (!msg) return true;
    switch (msg.t) {
      case 'lobby-state':
        if (view.state && msg.revision < view.state.revision) return true;
        settle(); update({ phase: 'ready', state: msg, name: msg.name,
          ...(view.phase === 'offline' || view.phase === 'loading' ? { notice: '' } : {}) }); poll(); break;
      case 'lobby-notice': settle(); update({ notice: msg.message,
        phase: view.phase === 'loading' ? 'offline' : view.phase }); break;
      case 'lobby-seat': adopt(msg); break;
    }
    return true;
  }
  function event(e: SignalEvent): void {
    if (disposed) return;
    if (e.type === 'msg' && serverMessage(e)) return;
    if (e.type === 'msg' && restoreSeat && e.msg.t === 'resumed') {
      const saved = { ...restoreSeat, role: e.msg.role ?? restoreSeat.role }; restoreSeat = null;
      adopt({ ...saved, token: e.msg.token }); options.onRestored?.();
      if (saved.role === 'host' && e.msg.peerPresent) {
        gameEvent?.({ type: 'msg', msg: { t: 'peer-joined', peerId: 'restored-peer', name: '对手' } });
      }
      return;
    }
    if (e.type === 'msg' && restoreSeat && e.msg.t === 'error') {
      restoreSeat = null; options.onSeat?.(null); update({ notice: '上一局已结束' }); return;
    }
    if (enabled && e.type === 'msg' && (e.msg.t === 'created' || e.msg.t === 'joined') && e.msg.token) {
      currentSeat = { t: 'lobby-seat', room: e.msg.room, peerId: e.msg.peerId, token: e.msg.token,
        role: e.msg.t === 'created' ? 'host' : 'guest' }; options.onSeat?.(currentSeat);
      update({ notice: '' });
    }
    if (e.type === 'msg' && e.msg.t === 'resumed' && currentSeat) {
      currentSeat = { ...currentSeat, token: e.msg.token, role: e.msg.role ?? currentSeat.role }; options.onSeat?.(currentSeat);
    }
    if (e.type === 'msg' && e.msg.t === 'peer-left' && currentSeat && e.msg.role) {
      currentSeat = { ...currentSeat, role: e.msg.role }; options.onSeat?.(currentSeat);
    }
    if (e.type === 'open') {
      attempts = 0; mustReconnect = false; enter();
      if (enabled && restoreSeat) raw?.send({ t: 'resume', room: restoreSeat.room, peerId: restoreSeat.peerId, token: restoreSeat.token });
    }
    if (enabled && (e.type === 'closed' || e.type === 'connect-timeout' || e.type === 'heartbeat-dead' || e.type === 'error')) lost();
    gameEvent?.(e);
    if (enabled && e.type === 'msg' && e.msg.t === 'error') {
      if (!currentSeat && manager?.getStatus().state === 'FAILED') manager.leave();
      update({ notice: e.msg.message });
    }
  }
  function send(msg: ClientLobbyMsg): boolean {
    if (!enabled || raw?.readyState !== 'open' || view.phase !== 'ready') return false;
    if (msg.t === 'lobby-list') { query = msg; return raw.send(msg); }
    if (msg.t === 'lobby-ready') return raw.send(msg);
    if (view.pending) return false;
    cancelled = msg.t === 'lobby-cancel' || (msg.t === 'lobby-match' && msg.action === 'leave');
    if (!raw.send(msg)) { update({ notice: '网络不给力，请重试' }); return false; }
    update({ pending: true, notice: '' });
    pendingTimer = clear(pendingTimer);
    pendingTimer = clock.setTimeout(() => { pendingTimer = null; update({ pending: false, notice: '请求超时，请重试' }); }, 8000);
    return true;
  }
  return {
    getSnapshot: () => view,
    subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    attach(signal: SignalTransport): SignalTransport {
      raw = signal; disposed = false; raw.onEvent(event);
      return {
        get readyState() { return signal.readyState; },
        connect(url, timeout) {
          if (signal.readyState === 'open' && !mustReconnect) gameEvent?.({ type: 'open' });
          else { mustReconnect = false; signal.connect(url, timeout); }
        },
        close(code = 1000) {
          if (enabled && !disposed) { gameEvent?.({ type: 'closed', code, intentional: true }); return; }
          signal.close(code);
        },
        send(msg) {
          if (msg.t === 'leave') { currentSeat = null; restoreSeat = null; options.onSeat?.(null); update({ notice: '' }); }
          if (assigned && (msg.t === 'create' || msg.t === 'join') && msg.room === assigned.room) {
            const seat = assigned; assigned = null;
            gameEvent?.({ type: 'msg', msg: { t: seat.role === 'host' ? 'created' : 'joined',
              room: seat.room, peerId: seat.peerId, token: seat.token } });
            return true;
          }
          return signal.send(msg);
        },
        onEvent(callback) { gameEvent = callback; },
      };
    },
    ready(connection: ConnectionManager) { manager = connection; connect(); },
    enable(supported: boolean) {
      enabled = supported;
      update({ phase: supported ? 'loading' : 'unsupported' });
      if (supported) { connect(); poll(); } else { pollTimer = clear(pollTimer); }
    },
    send,
    joinRoom(room: string) {
      if (!/^[A-Z0-9]{4}$/.test(room) || view.phase !== 'ready' || view.pending) return;
      manager?.joinRoom(room, view.name);
    },
    retry() { attempts = 0; if (manager?.getStatus().state === 'FAILED') manager.retryNow(); else connect(); },
    dispose() {
      disposed = true; retryTimer = clear(retryTimer); pendingTimer = clear(pendingTimer); pollTimer = clear(pollTimer);
      raw?.close(1000); raw = null; manager = null; assigned = null;
    },
  };
}
export type LobbyRuntime = ReturnType<typeof createLobbyRuntime>;
