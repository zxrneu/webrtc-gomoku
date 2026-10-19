import { describe, expect, it } from 'vitest';
import type { ClientLobbyMsg, ServerSignalingMsg, LobbyState, LobbySeat } from '@webrtc-gomoku/shared';
import { LobbyService, type LobbyClient } from '../../src/lobby/service';
import { RoomRegistry } from '../../src/rooms';

function setup() {
  let now = 10000;
  let next = 0;
  const rooms = new RoomRegistry();
  const service = new LobbyService({ rooms, now: () => now, id: () => `opaque-${++next}` });
  const messages = new Map<string, ServerSignalingMsg[]>();
  function client(id: string): LobbyClient {
    const list: ServerSignalingMsg[] = []; messages.set(id, list);
    return { id, send: msg => list.push(msg), issueSeat: (code, _name, role) => `${code}-${role}-secret` };
  }
  function enter(id: string, name = `棋友${id}`, browserId = id): LobbyClient {
    const c = client(id);
    service.handle(c, { t: 'lobby-enter', name, browserId, tabId: id });
    return c;
  }
  const state = (id: string): LobbyState => service.snapshot(id)!;
  const act = (c: LobbyClient, msg: ClientLobbyMsg) => service.handle(c, msg);
  const notice = (id: string, code: string) => messages.get(id)?.some(m => m.t === 'lobby-notice' && m.code === code);
  const seat = (id: string): LobbySeat | undefined => messages.get(id)?.find((m): m is LobbySeat => m.t === 'lobby-seat');
  return { service, rooms, enter, state, act, notice, seat, messages, advance: (ms: number) => { now += ms; service.flush(); } };
}

describe('大厅名册与房间', () => {
  it('每会话一秒内仅接受30个请求，其他会话仍可查询', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.messages.get('a')!.length = 0;
    for (let i = 0; i < 100; i++) t.act(a, { t: 'lobby-list' });
    expect(t.messages.get('a')!.filter(m => m.t === 'lobby-state')).toHaveLength(30);
    expect(t.notice('a', 'RATE_LIMITED')).toBe(true);
    t.act(b, { t: 'lobby-list' }); expect(t.notice('b', 'RATE_LIMITED')).toBe(false);
  });
  it('限流窗口满一秒后可恢复查询', () => {
    const t = setup(); const a = t.enter('a');
    for (let i = 0; i < 31; i++) t.act(a, { t: 'lobby-list' });
    t.advance(1000); t.messages.get('a')!.length = 0;
    t.act(a, { t: 'lobby-list' });
    expect(t.messages.get('a')).toHaveLength(1);
    expect(t.messages.get('a')![0]?.t).toBe('lobby-state');
  });
  it('被限流的改名请求不改变名册', () => {
    const t = setup(); const a = t.enter('a');
    for (let i = 0; i < 30; i++) t.act(a, { t: 'lobby-list' });
    t.act(a, { t: 'lobby-name', name: '不应改名' });
    expect(t.state('a').name).toBe('棋友a');
    expect(t.notice('a', 'RATE_LIMITED')).toBe(true);
  });
  it('同窗口刷新先替换旧登记，再判断浏览器会话上限', () => {
    const t = setup(); t.enter('old', '棋友甲', 'browser'); t.enter('other', '棋友乙', 'browser');
    const refreshed = t.enter('new', '棋友甲', 'new-browser');
    t.service.disconnect('new');
    t.act(refreshed, { t: 'lobby-enter', name: '棋友甲', browserId: 'browser', tabId: 'old' });
    expect(t.service.snapshot('new')).toMatchObject({ online: 2, name: '棋友甲' });
    expect(t.service.snapshot('old')).toBeNull();
    t.service.disconnect('old');
    expect(t.service.snapshot('new')?.online).toBe(2);
  });
  it('列出空闲用户且不公开物理 peerId 与凭证', () => {
    const t = setup(); t.enter('alice'); t.enter('bob');
    expect(t.state('alice').online).toBe(2);
    expect(t.state('alice').users.map(u => u.name)).toEqual(['棋友alice', '棋友bob']);
    expect(JSON.stringify(t.state('alice'))).not.toMatch(/secret|peerId|browserId|tabId/);
    expect(t.state('alice').selfId).not.toBe('alice');
  });
  it('同一浏览器最多两个会话，重复登记不增加在线人数', () => {
    const t = setup(); const a = t.enter('a', '小明', 'browser');
    t.act(a, { t: 'lobby-enter', name: '小明', browserId: 'browser', tabId: 'a' });
    t.enter('b', '小红', 'browser'); t.enter('c', '小白', 'browser');
    expect(t.state('a').online).toBe(2);
    expect(t.notice('c', 'SESSION_LIMIT')).toBe(true);
  });
  it('自动区分重名昵称并拒绝非法改名', () => {
    const t = setup(); t.enter('a', '小明'); const b = t.enter('b', '小明');
    expect(t.state('b').name).toBe('小明2');
    t.act(b, { t: 'lobby-name', name: '<script>' });
    expect(t.state('b').name).toBe('小明2');
    expect(t.notice('b', 'INVALID_NAME')).toBe(true);
  });
  it('成功改名会更新名册', () => {
    const t = setup(); const a = t.enter('a');
    t.act(a, { t: 'lobby-name', name: '松间棋友' });
    expect(t.state('a').users[0]?.name).toBe('松间棋友');
  });
  it('搜索覆盖后续页面且支持只看可邀请用户', () => {
    const t = setup(); const a = t.enter('a');
    for (let i = 0; i < 25; i++) t.enter(String(i), `棋友${i}`);
    expect(t.state('a').users).toHaveLength(20);
    t.act(a, { t: 'lobby-list', query: '棋友24', offset: 0, onlyAvailable: true });
    expect(t.state('a').users.map(u => u.name)).toEqual(['棋友24']);
  });
  it('手动信令会话忙碌时不能被大厅邀请或匹配打断', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(b, { t: 'lobby-ready', ready: true });
    expect(t.state('a').users.find(u => u.id === t.state('b').selfId)?.status).toBe('playing');
    t.act(a, { t: 'lobby-invite', target: t.state('b').selfId });
    expect(t.state('a').invite).toBeNull();
    t.act(b, { t: 'lobby-match', action: 'join' });
    expect(t.state('b').match).toBeNull();
  });
  it('公开建房进入列表，私密房间不进入列表', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(a, { t: 'lobby-create', public: true }); t.act(b, { t: 'lobby-create', public: false });
    expect(t.state('a').rooms).toHaveLength(1);
    expect(t.state('a').rooms[0]?.status).toBe('waiting');
    expect(t.rooms.roomCount).toBe(2);
  });
  it('只有房主能改变公开设置', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(a, { t: 'lobby-create', public: true }); const code = t.seat('a')!.room;
    t.act(b, { t: 'lobby-join', room: code });
    t.act(b, { t: 'lobby-visibility', public: false });
    expect(t.state('a').rooms).toHaveLength(1);
    t.act(a, { t: 'lobby-visibility', public: false });
    expect(t.state('a').rooms).toHaveLength(0);
  });
  it('列表加入时双人入座，第三人加入失败且不退出原房', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b'); const c = t.enter('c');
    t.act(a, { t: 'lobby-create', public: true }); const code = t.seat('a')!.room;
    t.act(b, { t: 'lobby-join', room: code }); t.act(c, { t: 'lobby-join', room: code });
    expect(t.rooms.others(code, 'a')).toHaveLength(1);
    expect(t.notice('c', 'ROOM_FULL')).toBe(true);
    expect(t.state('a').rooms[0]?.status).toBe('connecting');
    t.act(a, { t: 'lobby-ready', ready: true }); t.act(b, { t: 'lobby-ready', ready: true });
    expect(t.state('a').rooms[0]?.status).toBe('playing');
  });
  it('房主离线禁止加入，宽限回收后移除房间', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(a, { t: 'lobby-create', public: true }); const code = t.seat('a')!.room;
    t.service.disconnect('a'); t.act(b, { t: 'lobby-join', room: code });
    expect(t.state('b').rooms[0]?.status).toBe('offline');
    expect(t.seat('b')).toBeUndefined();
    t.rooms.leave('a'); t.service.flush(); expect(t.state('b').rooms).toEqual([]);
  });
});

describe('定向邀请', () => {
  function inviting() {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(a, { t: 'lobby-invite', target: t.state('b').selfId });
    return { ...t, a, b, id: t.state('a').invite!.id };
  }
  it('接受前没有房间，对方收到带昵称的邀请', () => {
    const t = inviting();
    expect(t.rooms.roomCount).toBe(0);
    expect(t.state('b').invite?.from.name).toBe('棋友a');
  });
  it('接受后恰好创建一间私密房并下发各自凭证', () => {
    const t = inviting(); t.act(t.b, { t: 'lobby-respond', id: t.id, accept: true });
    expect(t.rooms.roomCount).toBe(1); expect(t.seat('a')?.role).toBe('host');
    expect(t.seat('b')?.room).toBe(t.seat('a')?.room);
    expect(t.seat('b')?.role).toBe('guest'); expect(t.state('a').rooms).toEqual([]);
    expect(t.state('a').invite).toBeNull();
  });
  it('重复接受不重复建房或发送入座结果', () => {
    const t = inviting();
    t.act(t.b, { t: 'lobby-respond', id: t.id, accept: true });
    t.act(t.b, { t: 'lobby-respond', id: t.id, accept: true });
    expect(t.rooms.roomCount).toBe(1);
    expect(t.messages.get('a')?.filter(m => m.t === 'lobby-seat')).toHaveLength(1);
  });
  it('第三人不能接受、拒绝或取消他人邀请', () => {
    const t = inviting(); const c = t.enter('c');
    t.act(c, { t: 'lobby-respond', id: t.id, accept: true });
    t.act(c, { t: 'lobby-cancel', id: t.id });
    expect(t.state('a').invite?.id).toBe(t.id); expect(t.rooms.roomCount).toBe(0);
  });
  it('拒绝同步结束双方状态，冷却期内不能反复打扰', () => {
    const t = inviting(); t.act(t.b, { t: 'lobby-respond', id: t.id, accept: false });
    expect(t.state('a').invite).toBeNull(); expect(t.notice('a', 'DECLINED')).toBe(true);
    t.advance(4000); t.act(t.a, { t: 'lobby-invite', target: t.state('b').selfId });
    expect(t.notice('a', 'RATE_LIMITED')).toBe(true); expect(t.state('b').invite).toBeNull();
  });
  it('取消后迟到的接受不能建房', () => {
    const t = inviting(); t.act(t.a, { t: 'lobby-cancel', id: t.id });
    t.act(t.b, { t: 'lobby-respond', id: t.id, accept: true });
    expect(t.rooms.roomCount).toBe(0); expect(t.state('b').invite).toBeNull();
  });
  it('30秒后过期且不会自动接受或重发', () => {
    const t = inviting(); t.advance(30000);
    expect(t.state('a').invite).toBeNull(); expect(t.notice('a', 'EXPIRED')).toBe(true);
    t.act(t.b, { t: 'lobby-respond', id: t.id, accept: true }); expect(t.rooms.roomCount).toBe(0);
  });
  it('离线清除待处理邀请和在线会话', () => {
    const t = inviting(); t.service.disconnect('b');
    expect(t.state('a').invite).toBeNull(); expect(t.state('a').online).toBe(1);
  });
  it('交叉邀请复用原邀请但不自动接受', () => {
    const t = inviting(); t.act(t.b, { t: 'lobby-invite', target: t.state('a').selfId });
    expect(t.state('b').invite?.id).toBe(t.id); expect(t.rooms.roomCount).toBe(0);
  });
  it('不允许自邀或向已有房间的用户发邀请', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(a, { t: 'lobby-invite', target: t.state('a').selfId });
    expect(t.state('a').invite).toBeNull();
    t.act(b, { t: 'lobby-create', public: true });
    t.act(a, { t: 'lobby-invite', target: t.state('b').selfId });
    expect(t.state('a').invite).toBeNull(); expect(t.notice('a', 'BUSY')).toBe(true);
  });
  it('受邀方主动匹配使邀请失效且不会双重入座', () => {
    const t = inviting(); t.act(t.b, { t: 'lobby-match', action: 'join' });
    expect(t.state('a').invite).toBeNull(); expect(t.state('b').match).not.toBeNull();
    t.act(t.b, { t: 'lobby-respond', id: t.id, accept: true }); expect(t.rooms.roomCount).toBe(0);
  });
});

describe('快速匹配', () => {
  it('入队幂等，两人自动入座且清除队列', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(a, { t: 'lobby-match', action: 'join' }); t.act(a, { t: 'lobby-match', action: 'join' });
    expect(t.rooms.roomCount).toBe(0);
    t.act(b, { t: 'lobby-match', action: 'join' });
    expect(t.rooms.roomCount).toBe(1); expect(t.seat('a')?.room).toBe(t.seat('b')?.room);
    expect(t.state('a').match).toBeNull(); expect(t.state('b').match).toBeNull();
  });
  it('取消后没有幽灵配对，可以重新匹配', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(a, { t: 'lobby-match', action: 'join' }); t.act(a, { t: 'lobby-match', action: 'leave' });
    t.act(b, { t: 'lobby-match', action: 'join' }); expect(t.rooms.roomCount).toBe(0);
    t.act(a, { t: 'lobby-match', action: 'join' }); expect(t.rooms.roomCount).toBe(1);
  });
  it('匹配60秒超时清除队列', () => {
    const t = setup(); const a = t.enter('a'); t.act(a, { t: 'lobby-match', action: 'join' });
    t.advance(60000); expect(t.state('a').match).toBeNull(); expect(t.notice('a', 'MATCH_TIMEOUT')).toBe(true);
  });
  it('旧房间状态同步中断邀请，恢复后保留房间归属', () => {
    const t = setup(); const a = t.enter('a'); const b = t.enter('b');
    t.act(a, { t: 'lobby-invite', target: t.state('b').selfId });
    t.rooms.create('NEXT', b); t.service.syncRoom('b', '棋友b');
    expect(t.state('a').invite).toBeNull(); expect(t.state('b').room?.code).toBe('NEXT');
    t.service.disconnect('b'); const replacement = t.enter('new', '棋友b');
    t.rooms.rebind('b', { ...replacement, id: 'b' }); t.service.rebind('new', 'b');
    expect(t.state('b').room?.code).toBe('NEXT');
  });
});
