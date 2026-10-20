import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
describe('大厅在线构建接入', () => {
  it('服务器连接面板只提供大厅和自动房间连接', () => {
    const source = read('lobby/OnlineConnectionPanel.tsx');
    expect(source).toContain('openLobby'); expect(source).toContain('LegacyConnectionPanel');
    expect(source).not.toContain('手动信令'); expect(source).toContain('房间联机');
    expect(source).toContain('method="room"');
  });
  it('大厅独立页不渲染棋盘，并提供进入棋盘入口', () => {
    const source = read('lobby/LobbyPage.tsx');
    expect(source).toContain('LobbyPanel'); expect(source).not.toContain('<Board');
    expect(source).toContain('继续对局');
    expect(source).toContain('lobby-board-btn');
    expect(source).not.toContain('棋友相聚，从这里开始');
  });
  it('入口按构建标志挂载大厅服务', () => {
    expect(read('main.tsx')).toContain('__LOBBY_ENABLED__ ? <LobbyProvider>');
  });
});
