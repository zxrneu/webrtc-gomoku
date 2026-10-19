import { describe, expect, it } from 'vitest';
import { decodeLobbyClient, decodeLobbyServer, isLobbyName } from '../../src/lobby/codec';

describe('大厅协议边界', () => {
  it('中文昵称按码点校验且禁止标签、控制字符和首尾空白', () => {
    expect(isLobbyName('棋友4821')).toBe(true);
    expect(isLobbyName('棋友_小明')).toBe(true);
    for (const name of ['a', 'a'.repeat(13), '<img>', ' 小明', '小明 ', '小\n明', '小 明']) {
      expect(isLobbyName(name)).toBe(false);
    }
  });
  it.each([
    { t: 'lobby-enter', name: '小明', browserId: 'browser-1', tabId: 'tab-1' },
    { t: 'lobby-list', query: '棋友', onlyAvailable: true, offset: 20 },
    { t: 'lobby-invite', target: 'public-1' },
    { t: 'lobby-respond', id: 'invite-1', accept: true },
    { t: 'lobby-cancel', id: 'invite-1' },
    { t: 'lobby-match', action: 'join' },
    { t: 'lobby-create', public: true },
    { t: 'lobby-join', room: 'A1B2' },
    { t: 'lobby-visibility', public: false },
    { t: 'lobby-ready', ready: true },
    { t: 'lobby-name', name: '棋友22' },
  ])('接受并往返合法客户端消息 $t', (message) => {
    expect(decodeLobbyClient(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });
  it.each([
    null, [], 'bad', { t: 'unknown' }, { t: 'lobby-enter', name: '<script>' },
    { t: 'lobby-invite', target: 3 }, { t: 'lobby-respond', id: 'a', accept: 'yes' },
    { t: 'lobby-list', offset: -1 }, { t: 'lobby-list', offset: 1.5 },
    { t: 'lobby-list', query: 'x'.repeat(41) }, { t: 'lobby-match', action: 'other' },
    { t: 'lobby-create', public: 'true' }, { t: 'lobby-join', room: '<svg>' },
    { t: 'lobby-ready', ready: 1 }, { t: 'lobby-name', name: '\u0000bad' },
  ])('拒绝畸形客户端输入 %#', (message) => {
    expect(decodeLobbyClient(message)).toBeNull();
  });
  it('客户端解析只保留允许字段，丢弃伪造身份和凭证', () => {
    expect(decodeLobbyClient({ t: 'lobby-invite', target: 'public-1', peerId: 'victim', token: 'secret' }))
      .toEqual({ t: 'lobby-invite', target: 'public-1' });
  });
  it('解析仅对入座本人下发的有效房间凭证', () => {
    const message = { t: 'lobby-seat', room: 'A1B2', role: 'host', peerId: 'p1', token: 'secret' };
    expect(decodeLobbyServer(message)).toEqual(message);
    expect(decodeLobbyServer({ ...message, role: 'spectator' })).toBeNull();
    expect(decodeLobbyServer({ ...message, token: 4 })).toBeNull();
  });
  it('校验整份大厅快照与嵌套状态', () => {
    const state = { t: 'lobby-state', selfId: 'public-1', name: '小明', online: 1, waiting: 0,
      users: [{ id: 'public-1', name: '小明', status: 'idle' }], totalUsers: 1,
      rooms: [], totalRooms: 0, room: null, invite: null, match: null, serverNow: 1000, revision: 1 };
    expect(decodeLobbyServer(state)).toEqual(state);
    expect(decodeLobbyServer({ ...state, users: [{ id: 'p', name: '小明', status: 'admin' }] })).toBeNull();
    expect(decodeLobbyServer({ ...state, online: -1 })).toBeNull();
    expect(decodeLobbyServer({ ...state, invite: { id: 'x' } })).toBeNull();
    expect(decodeLobbyServer({ ...state, rooms: [{ code: 'bad' }] })).toBeNull();
  });
  it('拒绝未知服务端消息和无界错误内容', () => {
    expect(decodeLobbyServer({ t: 'lobby-notice', code: 'BUSY', message: '对方当前忙碌' }))
      .toEqual({ t: 'lobby-notice', code: 'BUSY', message: '对方当前忙碌' });
    expect(decodeLobbyServer({ t: 'other' })).toBeNull();
    expect(decodeLobbyServer({ t: 'lobby-notice', code: 'x', message: 'x'.repeat(501) })).toBeNull();
  });
});
