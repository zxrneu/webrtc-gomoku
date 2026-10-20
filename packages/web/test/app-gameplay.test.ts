import type { Dispatch, ReactElement, ReactNode, SetStateAction } from 'react';
import { isValidElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLACK, WHITE } from '@webrtc-gomoku/core';
import type { ConnSideEffect, GameMessage } from '@webrtc-gomoku/shared';
import { DEFAULT_POLICY, deriveStatus, initialSnapshot } from '@webrtc-gomoku/shared';

import type { ConnectionApi, UseConnectionOptions } from '../src/connection/useConnection';
import { App } from '../src/App';
import { Board } from '../src/components/Board/Board';
import { ConnectionPanel } from '../src/components/Connection/ConnectionPanel';
import { Header } from '../src/components/Header/Header';
import { ConfirmModal } from '../src/components/Modal/ConfirmModal';

// Run App's real callbacks with persistent hook slots, without mounting a DOM or network.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
const connection = vi.hoisted(() => ({
  api: null as ConnectionApi | null,
  options: null as UseConnectionOptions | null,
}));

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    }
    return [hooks.slots[index] as T, (value) => {
      hooks.slots[index] = typeof value === 'function'
        ? (value as (previous: T) => T)(hooks.slots[index] as T) : value;
    }];
  },
  useRef<T>(initial: T): { current: T } {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index] as { current: T };
  },
  useCallback<T>(callback: T): T { return callback; },
  useEffect() {},
}));

vi.mock('../src/connection/useConnection', () => ({
  useConnection(options: UseConnectionOptions) {
    connection.options = options;
    return connection.api;
  },
}));

function propsOf<P>(node: ReactNode, component: React.FC<P>): P {
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === component) return element.props as P;
  const children = [element.props.children].flat();
  for (const child of children) {
    if (!isValidElement(child)) continue;
    try { return propsOf(child, component); } catch { /* Search the next child. */ }
  }
  throw new Error('Component not found');
}

function renderApp() {
  hooks.cursor = 0;
  const tree = App({}) as ReactElement;
  return {
    board: propsOf(tree, Board),
    get panel() { return propsOf(tree, ConnectionPanel); },
    modal: propsOf(tree, ConfirmModal).modal,
    header: propsOf(tree, Header),
  };
}

function setConnected(isPlayable: boolean) {
  if (!connection.api) throw new Error('Connection not initialized');
  connection.api.status = {
    ...connection.api.status,
    state: isPlayable ? 'CONNECTED' : 'P2P_RECOVERING',
    isPlayable,
  };
  return renderApp();
}

function event(value: ConnSideEffect) {
  connection.options?.onEvent(value);
  return renderApp();
}

function receive(message: GameMessage) {
  if (message.t === 'undo-req' || message.t === 'restart-req') message = { ...message, requestId: 'peer-request' };
  connection.options?.onGameMessage(message);
  return renderApp();
}


function receiveReply(kind: 'undo' | 'restart') {
  const request = vi.mocked(connection.api!.send).mock.calls.map(([msg]) => msg).filter(msg => msg.t === `${kind}-req`).at(-1);
  return receive({ t: `${kind}-ok`, requestId: request && 'requestId' in request ? request.requestId : undefined });
}

describe('App gameplay coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.slots = [];
    hooks.cursor = 0;
    connection.api = {
      status: deriveStatus(initialSnapshot(0), DEFAULT_POLICY, 0),
      client: null,
      createRoom: vi.fn(), joinRoom: vi.fn(), retryNow: vi.fn(), leave: vi.fn(),
      send: vi.fn(() => true), notifyLocalMove: vi.fn(), notifyPeerGone: vi.fn(),
    };
    renderApp();
    event({ type: 'room-ready', room: 'TEST', role: 'host' });
    setConnected(true);
    event({ type: 'connected' });
    vi.mocked(connection.api.send).mockClear();
  });

  afterEach(() => { vi.useRealTimers(); });

  it('pauses local moves immediately after requesting a swap', () => {
    const app = renderApp();
    app.panel.onToggleColor();
    app.board.onMove(7, 7);

    expect(renderApp().board.moves).toEqual([]);
    expect(connection.api?.send).not.toHaveBeenCalledWith({ t: 'move', x: 7, y: 7 });
  });

  it('preserves the assigned color when toggled during reconnection', () => {
    setConnected(false).panel.onToggleColor();

    expect(setConnected(true).panel.myColor).toBe(BLACK);
  });

  it('does not send a restart that would replace a pending swap', () => {
    const app = renderApp();
    app.panel.onToggleColor();
    app.board.onRestart();

    expect(connection.api?.send).not.toHaveBeenCalledWith({ t: 'restart-req' });
  });

  it('rejects a peer restart while awaiting a swap response', () => {
    renderApp().panel.onToggleColor();
    receive({ t: 'restart-req' });

    expect(connection.api?.send).toHaveBeenCalledWith({ t: 'restart-no', requestId: 'peer-request' });
    expect(renderApp().modal.open).toBe(false);
  });

  it('keeps a received swap dialog when a peer undo arrives', () => {
    receive({ t: 'swap-req' });
    const app = receive({ t: 'undo-req' });

    expect(app.modal.title).toContain('换边');
    expect(connection.api?.send).toHaveBeenCalledWith({ t: 'undo-no', requestId: 'peer-request' });
  });

  it('keeps a received swap dialog when a peer restart arrives', () => {
    receive({ t: 'swap-req' });
    const app = receive({ t: 'restart-req' });

    expect(app.modal.title).toContain('换边');
    expect(connection.api?.send).toHaveBeenCalledWith({ t: 'restart-no', requestId: 'peer-request' });
  });

  it('rejects a swap that would replace another confirmation', () => {
    receive({ t: 'restart-req' });
    const app = receive({ t: 'swap-req' });

    expect(app.modal.title).toContain('重新开始');
    expect(connection.api?.send).toHaveBeenCalledWith({ t: 'swap-no' });
  });

  it('allows a new swap after the previous request is refused', () => {
    renderApp().panel.onToggleColor();
    receive({ t: 'swap-no' }).panel.onToggleColor();

    expect(vi.mocked(connection.api!.send).mock.calls).toEqual([
      [{ t: 'swap-req' }], [{ t: 'swap-req' }],
    ]);
  });

  it('cancels an unanswered swap when the data channel disconnects', () => {
    renderApp().panel.onToggleColor();
    connection.options?.onP2pDisconnected?.();
    setConnected(true).board.onMove(7, 7);

    expect(renderApp().board.moves).toEqual([{ x: 7, y: 7, c: BLACK }]);
  });

  it('keeps a pending swap through a PC warning while the data channel remains open', () => {
    connection.api!.client = { dc: { readyState: 'open' } } as ConnectionApi['client'];
    const app = renderApp();
    app.panel.onToggleColor();
    connection.options?.onP2pDisconnected?.();
    app.board.onMove(7, 7);

    expect(renderApp().board.moves).toEqual([]);
  });

  it('ignores an old confirmation callback after disconnecting', () => {
    const confirmation = receive({ t: 'swap-req' }).modal;
    connection.options?.onP2pDisconnected?.();
    setConnected(false);
    confirmation.onOk();

    expect(renderApp().panel.myColor).toBe(BLACK);
  });

  it('announces name and media capabilities when recovery establishes the first channel', () => {
    event({ type: 'restored', via: 'ice-restart', movesSynced: 1 });

    expect(connection.api?.send).toHaveBeenCalledWith(expect.objectContaining({
      t: 'hello', name: expect.any(String),
      capabilities: expect.objectContaining({ file: true, audio: expect.any(Boolean) }),
    }));
  });

  it('reconciles the host color when the connection is restored', () => {
    event({ type: 'restored', via: 'rebuild', movesSynced: 0 });

    expect(connection.api?.send).toHaveBeenCalledWith({ t: 'color', color: BLACK });
  });

  it('waits for the host color after an accepted guest swap is interrupted', () => {
    event({ type: 'room-ready', room: 'TEST', role: 'guest' });
    setConnected(true);
    event({ type: 'connected' });
    receive({ t: 'swap-req' }).modal.onOk();
    expect(renderApp().panel.myColor).toBe(BLACK);
    connection.options?.onP2pDisconnected?.();
    setConnected(false);
    setConnected(true);
    event({ type: 'restored', via: 'rebuild', movesSynced: 0 }).board.onMove(7, 7);

    expect(renderApp().board.moves).toEqual([]);
  });

  it('resumes guest moves after the restored host color arrives', () => {
    event({ type: 'room-ready', room: 'TEST', role: 'guest' });
    setConnected(true);
    event({ type: 'connected' });
    connection.options?.onP2pDisconnected?.();
    setConnected(false);
    setConnected(true);
    receive({ t: 'color', color: WHITE }).board.onMove(7, 7);

    expect(renderApp().board.moves).toEqual([{ x: 7, y: 7, c: BLACK }]);
  });

  it('does not change color when accepting the swap cannot be sent', () => {
    const app = receive({ t: 'swap-req' });
    vi.mocked(connection.api!.send).mockReturnValue(false);
    app.modal.onOk();

    expect(renderApp().panel.myColor).toBe(BLACK);
  });

  it('resumes moves after a swap refusal', () => {
    renderApp().panel.onToggleColor();
    receive({ t: 'swap-no' }).board.onMove(7, 7);

    expect(renderApp().board.moves).toEqual([{ x: 7, y: 7, c: BLACK }]);
  });

  it('applies an accepted swap only once', () => {
    renderApp().panel.onToggleColor();
    receive({ t: 'swap-ok' });

    expect(receive({ t: 'swap-ok' }).panel.myColor).toBe(WHITE);
  });

  it('allows preselecting a color before the first connection', () => {
    event({ type: 'room-ready', room: 'NEXT', role: 'host' });
    setConnected(false).panel.onToggleColor();

    expect(renderApp().panel.myColor).toBe(WHITE);
  });
  it.each(['undo', 'restart'] as const)('ignores unsolicited %s confirmations', (kind) => {
    renderApp().board.onMove(7, 7);
    receive({ t: `${kind}-ok` });
    expect(renderApp().board.moves).toHaveLength(1);
  });

  it.each(['undo', 'restart'] as const)('commits an accepted %s only once', (kind) => {
    renderApp().board.onMove(7, 7);
    const app = renderApp();
    if (kind === 'undo') app.board.onUndo(); else app.board.onRestart();
    receiveReply(kind);
    expect(renderApp().board.moves).toHaveLength(0);
    renderApp().board.onMove(8, 8);
    receive({ t: `${kind}-ok` });
    expect(renderApp().board.moves).toHaveLength(1);
  });

  it.each(['undo', 'restart'] as const)('preserves the board when %s confirmation cannot be sent', (kind) => {
    renderApp().board.onMove(7, 7);
    const modal = receive({ t: `${kind}-req` }).modal;
    vi.mocked(connection.api!.send).mockReturnValue(false);
    modal.onOk();
    expect(renderApp().board.moves).toHaveLength(1);
  });

  it('ignores an old restart dialog after a new room is ready', () => {
    renderApp().board.onMove(7, 7);
    const oldModal = receive({ t: 'restart-req' }).modal;
    event({ type: 'room-ready', room: 'NEXT', role: 'host' });
    setConnected(true).board.onMove(8, 8);
    oldModal.onOk();
    expect(renderApp().board.moves).toHaveLength(1);
  });

  it.each(['undo', 'restart'] as const)('invalidates %s confirmations when a move changes the board', (kind) => {
    renderApp().board.onMove(7, 7);
    const app = renderApp();
    if (kind === 'undo') app.board.onUndo(); else app.board.onRestart();
    receive({ t: 'move', x: 8, y: 8 });
    receive({ t: `${kind}-ok` });
    expect(renderApp().board.moves).toHaveLength(2);
  });

  it.each(['undo', 'restart'] as const)('invalidates incoming %s dialogs after a move', (kind) => {
    renderApp().board.onMove(7, 7);
    const oldModal = receive({ t: `${kind}-req` }).modal;
    receive({ t: 'move', x: 8, y: 8 });
    oldModal.onOk();
    expect(renderApp().board.moves).toHaveLength(2);
  });

  it('ignores restart confirmation after switching modes and back', () => {
    renderApp().board.onMove(7, 7);
    renderApp().board.onRestart();
    renderApp().header.onModeChange('ai');
    renderApp().header.onModeChange('online');
    receive({ t: 'restart-ok' });
    expect(renderApp().board.moves).toHaveLength(1);
  });

  it('does not arm a restart whose request could not be sent', () => {
    renderApp().board.onMove(7, 7);
    vi.mocked(connection.api!.send).mockReturnValue(false);
    renderApp().board.onRestart();
    receive({ t: 'restart-ok' });
    expect(renderApp().board.moves).toHaveLength(1);
  });

  it('invalidates restart confirmation across a data channel disconnect', () => {
    renderApp().board.onMove(7, 7);
    renderApp().board.onRestart();
    connection.options?.onP2pDisconnected?.();
    setConnected(false);
    setConnected(true);
    receive({ t: 'restart-ok' });
    expect(renderApp().board.moves).toHaveLength(1);
  });

  it('pauses local moves while a restart request is awaiting a reply', () => {
    renderApp().board.onRestart();
    renderApp().board.onMove(7, 7);
    expect(renderApp().board.moves).toHaveLength(0);
    const request = vi.mocked(connection.api!.send).mock.calls.find(([msg]) => msg.t === 'restart-req')?.[0];
    receive({ t: 'restart-no', requestId: request && 'requestId' in request ? request.requestId : undefined }).board.onMove(7, 7);
    expect(renderApp().board.moves).toHaveLength(1);
  });

  it('updates the restored role before a following effect in the same event loop', () => {
    connection.options?.onEvent({ type: 'role-changed', role: 'guest' });
    connection.options?.onEvent({ type: 'restored', via: 'rebuild', movesSynced: 0 });
    expect(connection.api?.send).not.toHaveBeenCalledWith({ t: 'color', color: BLACK });
    expect(renderApp().panel.isHost).toBe(false);
  });

  it('preserves the board when only the restored room role changes', () => {
    renderApp().board.onMove(7, 7);
    event({ type: 'role-changed', role: 'guest' });
    expect(renderApp().board.moves).toHaveLength(1);
  });

});
