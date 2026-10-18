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
    panel: propsOf(tree, ConnectionPanel),
    modal: propsOf(tree, ConfirmModal).modal,
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
  connection.options?.onGameMessage(message);
  return renderApp();
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

    expect(connection.api?.send).toHaveBeenCalledWith({ t: 'restart-no' });
    expect(renderApp().modal.open).toBe(false);
  });

  it('keeps a received swap dialog when a peer undo arrives', () => {
    receive({ t: 'swap-req' });
    const app = receive({ t: 'undo-req' });

    expect(app.modal.title).toContain('换边');
    expect(connection.api?.send).toHaveBeenCalledWith({ t: 'undo-no' });
  });

  it('keeps a received swap dialog when a peer restart arrives', () => {
    receive({ t: 'swap-req' });
    const app = receive({ t: 'restart-req' });

    expect(app.modal.title).toContain('换边');
    expect(connection.api?.send).toHaveBeenCalledWith({ t: 'restart-no' });
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
});
