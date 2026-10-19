import type { ClientLobbyMsg, LobbyInvite, LobbyRoom, LobbyUser, ServerLobbyMsg } from './types';

type Data = Record<string, unknown>;
const record = (v: unknown): v is Data => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 100): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const room = (v: unknown): v is string => typeof v === 'string' && /^[A-Z0-9]{4}$/.test(v);
const role = (v: unknown): v is 'host' | 'guest' => v === 'host' || v === 'guest';
const nullable = (v: unknown, validate: (value: unknown) => boolean): boolean => v === null || validate(v);

/** 大厅昵称按 Unicode 码点计算，只接收中英文、数字和下划线。 */
export function isLobbyName(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{L}\p{N}_]{2,12}$/u.test(value);
}

/** 在 IO 边界校验客户端输入，同时去除未声明字段。 */
export function decodeLobbyClient(value: unknown): ClientLobbyMsg | null {
  if (!record(value)) return null;
  switch (value.t) {
    case 'lobby-enter':
      return isLobbyName(value.name) && text(value.browserId) && text(value.tabId)
        ? { t: value.t, name: value.name, browserId: value.browserId, tabId: value.tabId } : null;
    case 'lobby-name': return isLobbyName(value.name) ? { t: value.t, name: value.name } : null;
    case 'lobby-invite': return text(value.target) ? { t: value.t, target: value.target } : null;
    case 'lobby-respond':
      return text(value.id) && typeof value.accept === 'boolean' ? { t: value.t, id: value.id, accept: value.accept } : null;
    case 'lobby-cancel': return text(value.id) ? { t: value.t, id: value.id } : null;
    case 'lobby-match':
      return value.action === 'join' || value.action === 'leave' ? { t: value.t, action: value.action } : null;
    case 'lobby-create':
    case 'lobby-visibility': return typeof value.public === 'boolean' ? { t: value.t, public: value.public } : null;
    case 'lobby-ready': return typeof value.ready === 'boolean' ? { t: value.t, ready: value.ready } : null;
    case 'lobby-join': return room(value.room) ? { t: value.t, room: value.room } : null;
    case 'lobby-list': return decodeList(value);
    default: return null;
  }
}

function decodeList(value: Data): ClientLobbyMsg | null {
  if (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 40)) return null;
  if (value.onlyAvailable !== undefined && typeof value.onlyAvailable !== 'boolean') return null;
  if (value.offset !== undefined && (!count(value.offset) || value.offset > 100000)) return null;
  return { t: 'lobby-list', ...(value.query !== undefined ? { query: value.query as string } : {}),
    ...(value.onlyAvailable !== undefined ? { onlyAvailable: value.onlyAvailable as boolean } : {}),
    ...(value.offset !== undefined ? { offset: value.offset as number } : {}) };
}

function user(value: unknown): value is LobbyUser {
  return record(value) && text(value.id) && isLobbyName(value.name) &&
    ['idle', 'matching', 'inviting', 'waiting', 'connecting', 'playing'].includes(String(value.status));
}
function listedRoom(value: unknown): value is LobbyRoom {
  return record(value) && room(value.code) && text(value.name, 40) && count(value.count) && value.count <= 2 &&
    count(value.createdAt) && ['waiting', 'connecting', 'playing', 'offline'].includes(String(value.status));
}
function invite(value: unknown): value is LobbyInvite {
  return record(value) && text(value.id) && count(value.expiresAt) &&
    record(value.from) && text(value.from.id) && isLobbyName(value.from.name) &&
    record(value.to) && text(value.to.id) && isLobbyName(value.to.name);
}
function state(value: Data): boolean {
  return text(value.selfId) && isLobbyName(value.name) && count(value.online) && count(value.waiting) &&
    count(value.totalUsers) && count(value.totalRooms) && count(value.serverNow) && count(value.revision) &&
    Array.isArray(value.users) && value.users.length <= 20 && value.users.every(user) &&
    Array.isArray(value.rooms) && value.rooms.length <= 100 && value.rooms.every(listedRoom) &&
    nullable(value.room, v => record(v) && room(v.code) && typeof v.public === 'boolean' && role(v.role)) &&
    nullable(value.invite, invite) &&
    nullable(value.match, v => record(v) && count(v.since) && count(v.expiresAt));
}

/** 对服务端快照及其嵌套数据做完整校验，异常报文不能进入 UI。 */
export function decodeLobbyServer(value: unknown): ServerLobbyMsg | null {
  if (!record(value)) return null;
  if (value.t === 'lobby-state' && state(value)) return value as unknown as ServerLobbyMsg;
  if (value.t === 'lobby-seat' && room(value.room) && role(value.role) && text(value.peerId) && text(value.token, 256)) {
    return { t: value.t, room: value.room, role: value.role, peerId: value.peerId, token: value.token };
  }
  if (value.t === 'lobby-notice' && text(value.code, 50) && text(value.message, 500)) {
    return { t: value.t, code: value.code, message: value.message };
  }
  return null;
}
