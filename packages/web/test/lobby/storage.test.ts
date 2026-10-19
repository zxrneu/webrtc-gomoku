import { describe, expect, it } from 'vitest';
import { createLobbyId, lobbyIdentity, prepareLobbyWindow, readLobbySession, saveLobbySession } from '../../src/lobby/storage';

function store() { const values = new Map<string, string>(); return {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
}; }
const session = { seat: { t: 'lobby-seat' as const, room: 'A1B2', role: 'host' as const, peerId: 'p1', token: 'secret' },
  moves: [{ x: 7, y: 7, c: 1 as const }], name: '小明' };

describe('大厅本地会话隔离', () => {
  it('新弹窗清除复制的窗口身份和座位，保留浏览器共享身份', () => {
    const local = store(); const source = store(); const cloned = store(); let n = 0;
    const original = lobbyIdentity(local, source, () => `id-${++n}`);
    cloned.setItem('gomoku:lobby-tab', original.tabId); saveLobbySession(cloned, session);
    prepareLobbyWindow(cloned, { hasOpener: true, navigationType: 'navigate' });
    const popup = lobbyIdentity(local, cloned, () => `id-${++n}`);
    expect(popup.browserId).toBe(original.browserId); expect(popup.tabId).not.toBe(original.tabId);
    expect(readLobbySession(cloned)).toBeNull();
    expect(lobbyIdentity(local, source, () => 'unexpected')).toEqual(original);
  });
  it.each(['reload', 'back_forward'])('弹窗真正%s保留本窗口身份和座位', navigationType => {
    const s = store(); s.setItem('gomoku:lobby-tab', 'popup'); saveLobbySession(s, session);
    prepareLobbyWindow(s, { hasOpener: true, navigationType });
    expect(s.getItem('gomoku:lobby-tab')).toBe('popup'); expect(readLobbySession(s)).toEqual(session);
  });
  it('无opener的正常窗口不清除刷新凭证', () => {
    const s = store(); saveLobbySession(s, session);
    prepareLobbyWindow(s, { hasOpener: false, navigationType: 'navigate' });
    expect(readLobbySession(s)).toEqual(session);
  });
  it('会话保存换边后的执色，刷新时不会回到默认黑方', () => {
    const s = store(); s.setItem('gomoku:lobby-session', JSON.stringify({ ...session, myColor: 2 }));
    expect(readLobbySession(s)).toMatchObject({ myColor: 2 });
  });
  it('使用随机字节生成身份，兼容没有 randomUUID 的局域网 HTTP 页面', () => {
    expect(createLobbyId(bytes => bytes.fill(15))).toBe('0f'.repeat(16));
  });
  it('浏览器标识跨页稳定，每个新窗口有独立标识，刷新复用窗口标识', () => {
    const local = store(); const tabA = store(); const tabB = store(); let n = 0;
    const a = lobbyIdentity(local, tabA, () => `id-${++n}`);
    const b = lobbyIdentity(local, tabB, () => `id-${++n}`);
    expect(a.browserId).toBe(b.browserId); expect(a.tabId).not.toBe(b.tabId);
    expect(lobbyIdentity(local, tabA, () => 'unexpected')).toEqual(a);
  });
  it('存储不可用时仍能生成临时身份', () => {
    const broken = { getItem() { throw Error('disabled'); }, setItem() { throw Error('disabled'); }, removeItem() {} };
    const id = lobbyIdentity(broken, broken, () => 'temporary');
    expect(id).toEqual({ browserId: 'temporary', tabId: 'temporary' });
  });
  it('刷新恢复房间凭证和校验后的棋谱；主动离开会清除', () => {
    const s = store(); saveLobbySession(s, session); expect(readLobbySession(s)).toEqual(session);
    saveLobbySession(s, null); expect(readLobbySession(s)).toBeNull();
  });
  it('拒绝被篡改的座位和非法棋谱，不执行存储内容', () => {
    const s = store(); s.setItem('gomoku:lobby-session', '{bad'); expect(readLobbySession(s)).toBeNull();
    s.setItem('gomoku:lobby-session', JSON.stringify({ ...session, moves: [{ x: 99, y: 7, c: 1 }] }));
    expect(readLobbySession(s)).toBeNull();
    s.setItem('gomoku:lobby-session', JSON.stringify({ ...session, seat: { ...session.seat, role: 'admin' } }));
    expect(readLobbySession(s)).toBeNull();
  });
});
