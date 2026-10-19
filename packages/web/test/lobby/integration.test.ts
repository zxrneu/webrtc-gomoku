import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
describe('大厅在线构建接入', () => {
  it('连接面板保留原有两种方式并增加大厅入口', () => {
    const source = read('lobby/OnlineConnectionPanel.tsx');
    expect(source).toContain('openLobby'); expect(source).toContain('LegacyConnectionPanel');
    expect(source).toContain('手动信令'); expect(source).toContain('房间联机');
  });
  it('大厅独立页不渲染棋盘，并提供进入棋盘入口', () => {
    const source = read('lobby/LobbyPage.tsx');
    expect(source).toContain('LobbyPanel'); expect(source).not.toContain('<Board');
    expect(source).toContain('返回棋盘');
  });
  it('入口按构建标志挂载大厅服务', () => {
    expect(read('main.tsx')).toContain('__LOBBY_ENABLED__ ? <LobbyProvider>');
  });
});
