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
  it('匹配与开桌都明确说明进入对局的方式', () => {
    const html = render();
    expect(html).toContain('随机找一位在线玩家');
    expect(html).toContain('创建公开房间，等棋友加入');
  });
  it('提供在线棋友与房间广场，空闲用户可邀请，自己不能自邀', () => {
    const html = render(); expect(html).toContain('在线棋友'); expect(html).toContain('房间广场');
    expect(html.match(/data-invite-user=/g)).toHaveLength(2);
    expect(html).toContain('你'); expect(html).toContain('对局中'); expect(html).toContain('不可邀请');
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
