import { BLACK, WHITE, type Move, type PlayerColor } from '@webrtc-gomoku/core';
import { decodeLobbyServer, isLobbyName, replayMoves, type LobbySeat } from '@webrtc-gomoku/shared';

interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface LobbySession { seat: LobbySeat; moves: Move[]; name: string; myColor?: PlayerColor }
const KEY = 'gomoku:lobby-session';

/** 弹窗首次导航会复制 sessionStorage；刷新和历史返回则保留本窗口座位。 */
export function prepareLobbyWindow(store: Store, navigation: { hasOpener: boolean; navigationType?: string }): void {
  if (!navigation.hasOpener || navigation.navigationType === 'reload' || navigation.navigationType === 'back_forward') return;
  try { store.removeItem('gomoku:lobby-tab'); store.removeItem(KEY); } catch { /* 无存储时使用临时身份。 */ }
}

/** 使用 getRandomValues 而非仅安全上下文可用的 randomUUID，支持局域网 HTTP。 */
export function createLobbyId(randomBytes: (bytes: Uint8Array) => Uint8Array): string {
  return Array.from(randomBytes(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** 浏览器共享标识与窗口独立标识分开保存；存储被禁用时退化为临时会话。 */
export function lobbyIdentity(local: Store, session: Store, id: () => string) {
  const read = (store: Store, key: string) => {
    try {
      const found = store.getItem(key);
      if (found && found.length <= 100) return found;
      const value = id(); store.setItem(key, value); return value;
    } catch { return id(); }
  };
  return { browserId: read(local, 'gomoku:lobby-browser'), tabId: read(session, 'gomoku:lobby-tab') };
}

/** 只读取当前窗口的会话；所有存储内容视为外部输入。 */
export function readLobbySession(store: Store): LobbySession | null {
  try {
    const value: unknown = JSON.parse(store.getItem(KEY) ?? 'null');
    if (!value || typeof value !== 'object' || !('seat' in value) || !('moves' in value) || !('name' in value)) return null;
    const seat = decodeLobbyServer(value.seat);
    if (seat?.t !== 'lobby-seat' || !isLobbyName(value.name) || !Array.isArray(value.moves) || value.moves.length > 225) return null;
    if ('myColor' in value && value.myColor !== BLACK && value.myColor !== WHITE) return null;
    const valid = value.moves.every((m: unknown) => m && typeof m === 'object' && 'x' in m && 'y' in m && 'c' in m &&
      Number.isInteger(m.x) && Number.isInteger(m.y) && (m.c === 1 || m.c === 2));
    if (!valid || !replayMoves(value.moves as Move[]).ok) return null;
    return { seat, moves: value.moves as Move[], name: value.name,
      ...('myColor' in value ? { myColor: value.myColor as PlayerColor } : {}) };
  } catch { return null; }
}

/** 凭证只写当前窗口 sessionStorage；主动离开清除，不写 URL 或日志。 */
export function saveLobbySession(store: Store, session: LobbySession | null): void {
  try { if (session) store.setItem(KEY, JSON.stringify(session)); else store.removeItem(KEY); } catch { /* 无存储仍可在线对局。 */ }
}
