import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BLACK, WHITE } from '@webrtc-gomoku/core';
import { ConnectionPanel, type ConnectionPanelProps } from '../../src/components/Connection/ConnectionPanel';
import { OnlineConnectionPanel } from '../../src/lobby/OnlineConnectionPanel';
import { Header } from '../../src/components/Header/Header';
import { LobbyContext } from '../../src/lobby/LobbyProvider';
import { LobbyPage } from '../../src/lobby/LobbyPage';
import type { LobbyRuntime } from '../../src/lobby/runtime';

const noop = vi.fn();
const props: ConnectionPanelProps = {
  myColor: BLACK, isHost: true, connected: false, onToggleColor: noop, name: '棋友', setName: noop,
  flow: 'idle', roomCode: 'ABCD', inputRoomCode: '',
  setInputRoomCode: noop, roomStatus: '等待对手加入', hostOfferCode: '', guestOfferInput: '',
  setGuestOfferInput: noop, hostAnswerInput: '', setHostAnswerInput: noop, guestAnswerCode: '',
  hostTimer: '0:00', hostTextFolded: true, setHostTextFolded: noop,
  guestTextFolded: true, setGuestTextFolded: noop, onCreateRoom: noop, onJoinRoom: noop,
  onCopyInviteLink: noop, onStartAi: noop, onStartHostFlow: noop, onStartGuestFlow: noop, onCopyHostOffer: noop,
  onCopyGuestAnswer: noop, onGuestGenerateAnswer: noop, onHostFinish: noop, onOpenScanner: noop, flowResult: null,
};

describe('紧凑执子切换', () => {
  it.each([
    [BLACK, false, '切换为执白'],
    [WHITE, false, '切换为执黑'],
    [BLACK, true, '申请换边（切换执黑/执白）'],
  ] as const)('按钮保持短文案并说明切换动作（执子 %s，已连接 %s）', (myColor, connected, label) => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, { ...props, myColor, connected }));
    const button = html.match(/<button[^>]*id="toggle-color-btn"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('>切换</button>');
    expect(button).toContain(`aria-label="${label}"`);
    expect(button).toContain(`title="${label}"`);
  });
});

describe('部署方式决定信令入口', () => {
  it('房间标题移入棋盘后，设置面板不再重复房间号和邀请按钮', () => {
    const html = renderToStaticMarkup(React.createElement(OnlineConnectionPanel, { ...props, roomHeadingExternal: true }));
    expect(html).not.toContain('id="room-code-text"');
    expect(html).not.toContain('id="copy-link-btn"');
    expect(html).not.toContain('id="room-info"');
    expect(html).toContain('id="switch-room-btn"');
    expect(html).not.toContain('id="toggle-color-btn"');
    expect(html).not.toContain('id="role-select-box"');
    expect(html).not.toContain('id="name-input"');
    expect(html).not.toContain('aria-label="联机方式"');
    expect(html).toContain('id="room-navigation"');
    expect(html).toContain('退出房间');
    expect(html).not.toContain('id="room-ai-btn"');
  });
  it('服务器房间只显示自动配对入口，不渲染手动信令表单', () => {
    const html = renderToStaticMarkup(React.createElement(OnlineConnectionPanel, { ...props, roomCode: '' }));
    expect(html).toContain('id="create-room-btn"');
    expect(html).toContain('id="join-room-btn"');
    expect(html).not.toContain('id="tab-manual"');
    expect(html).not.toContain('id="flow-host-in"');
    expect(html).not.toContain('data-tab="manual"');
  });

  it.each([false, true])('已入房后收起创建和加入表单（已连接：%s）', (connected) => {
    const html = renderToStaticMarkup(React.createElement(OnlineConnectionPanel, { ...props, connected }));
    expect(html).toContain('ABCD');
    expect(html).toContain('复制邀请链接');
    expect(html).toContain('切换房间');
    expect(html).not.toContain('id="create-room-btn"');
    expect(html).not.toContain('id="join-room-btn"');
    expect(html).not.toContain('输入 4 位房间号或点击');
  });

  it('房间面板直接提供人机对弈入口', () => {
    const html = renderToStaticMarkup(React.createElement(OnlineConnectionPanel, props));
    expect(html).toContain('id="room-ai-btn"');
    expect(html).toContain('人机对弈');
  });

  it('大厅直接提供人机对弈入口，无需先返回棋盘', () => {
    const value: NonNullable<React.ContextType<typeof LobbyContext>> = {
      openLobby: noop, openGame: noop, runtime: { send: noop } as unknown as LobbyRuntime,
      view: { phase: 'offline', name: '棋友', pending: false, notice: '', state: null }, now: 0,
      retry: noop, bind: noop, persist: noop, leave: noop,
    };
    const html = renderToStaticMarkup(React.createElement(LobbyContext.Provider, { value }, React.createElement(LobbyPage)));
    expect(html).toContain('id="lobby-ai-btn"');
    expect(html).toContain('人机对弈');
  });

  it('独立 HTML 默认直接显示手动邀请，不显示不可用的房间入口', () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, props));
    expect(html).toContain('id="flow-host-btn"');
    expect(html).toContain('id="flow-guest-btn"');
    expect(html).not.toContain('id="tab-room"');
    expect(html).not.toContain('id="create-room-btn"');
    expect(html).not.toContain('display:none;flex-direction:column');
  });

  it('独立 HTML 页头说明互发连接码', () => {
    const html = renderToStaticMarkup(React.createElement(Header, { status: 'offline', statusText: '未连接', mode: 'online', onModeChange: noop }));
    // 单测默认采用 standalone 构建，与独立 HTML 保持一致。
    expect(html).toContain('互发连接码');
  });
});
