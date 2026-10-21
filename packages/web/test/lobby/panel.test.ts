import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LobbyPanel } from '../../src/lobby/LobbyPanel';
import type { LobbyView } from '../../src/lobby/runtime';

const view: LobbyView = { phase: 'ready', name: '小明', pending: false, notice: '', state: {
  t: 'lobby-state', selfId: 'self', name: '小明', online: 3, waiting: 0, totalUsers: 3, totalRooms: 0,
  users: [{ id: 'self', name: '小明', status: 'idle' }, { id: 'other', name: '小红', status: 'idle' },
    { id: 'busy', name: '松间', status: 'playing' }], rooms: [], room: null, match: null, invite: null,
  serverNow: 10000, revision: 1 } };
function render(current = view) {
  return renderToStaticMarkup(React.createElement(LobbyPanel, { view: current, send: vi.fn(), retry: vi.fn(),
    leave: vi.fn(), onRoom: vi.fn(), onName: vi.fn(), playable: false, now: 10000 }));
}

describe('大厅界面行为表达', () => {
  it('开局操作与棋友浏览各有独立的可访问区域', () => {
    const html = render();
    expect(html).toContain('aria-label="开局操作"');
    expect(html).toContain('aria-label="棋友与房间"');
    expect(html).toContain('落子，遇见棋友。');
  });
  it('房号输入有可见说明，帮助已有房号的玩家直接加入', () => {
    const html = render();
    expect(html).toContain('已有房号，直接赴约');
    expect(html).toContain('来下一盘？');
  });
  it('匹配中仍保留独立的棋友浏览区域', () => {
    const html = render({ ...view, state: { ...view.state!, match: { since: 0, expiresAt: 60000 } } });
    expect(html).toContain('aria-label="棋友与房间"');
    expect(html).toContain('取消匹配');
    expect(html).not.toContain('id="quick-match"');
  });
  it('首页提供房间号加入入口，并使用玩家能理解的统计', () => {
    const html = render();
    expect(html).toContain('id="lobby-room-code"');
    expect(html).toContain('加入房间');
    expect(html).not.toContain('个会话');
    expect(html).not.toContain('同一浏览器');
  });
  it('棋友列表不展示内部会话编号，忙碌状态说明等待对手', () => {
    const html = render({ ...view, state: { ...view.state!, users: [{ id: 'raw-secret-id', name: '竹影', status: 'waiting' }] } });
    expect(html).not.toContain('secret-id');
    expect(html).toContain('等待对手');
    expect(html).not.toContain('不可邀请');
  });
  it('匹配与开桌都明确说明进入对局的方式', () => {
    const html = render();
    expect(html).toContain('与正在匹配的棋友配对');
    expect(html).toContain('创建公开房间，等棋友加入');
  });
  it('提供在线棋友与房间广场，空闲用户可邀请，自己不能自邀', () => {
    const html = render(); expect(html).toContain('在线棋友'); expect(html).toContain('房间广场');
    expect(html.match(/data-invite-user=/g)).toHaveLength(1);
    expect(html.match(/小明/g)).toHaveLength(1); expect(html).toContain('对弈中');
    expect(html).not.toContain('不可邀请'); expect(html).not.toContain('data-invite-user="busy"');
  });
  it('受邀方有明确接受和拒绝动作', () => {
    const html = render({ ...view, state: { ...view.state!, invite: { id: 'i', from: { id: 'other', name: '小红' },
      to: { id: 'self', name: '小明' }, expiresAt: 40000 } } });
    expect(html).toContain('接受邀请'); expect(html).toContain('暂不接受'); expect(html).toContain('小红');
  });
  it('匹配中可取消且不把等待状态表达成已经开局', () => {
    const html = render({ ...view, state: { ...view.state!, match: { since: 0, expiresAt: 60000 } } });
    expect(html).toContain('正在为你寻找对手'); expect(html).toContain('取消匹配'); expect(html).not.toContain('匹配成功');
  });
  it('故障和旧服务端能力有可恢复说明', () => {
    expect(render({ ...view, phase: 'offline', state: null })).toContain('重试');
    expect(render({ ...view, phase: 'unsupported', state: null })).toContain('大厅需要更新后的信令服务器');
  });
  it('恶意昵称始终按文本渲染，不生成用户提供的标签', () => {
    const html = render({ ...view, state: { ...view.state!, users: [{ id: 'other', name: '<img src=x>', status: 'idle' }] } });
    expect(html).toContain('&lt;img src=x&gt;'); expect(html).not.toContain('<img');
  });
});
