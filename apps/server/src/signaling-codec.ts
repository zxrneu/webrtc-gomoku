import type { ClientLobbyMsg, ClientSignalingMsg } from '@webrtc-gomoku/shared';

type SignalingCommand = Exclude<ClientSignalingMsg, ClientLobbyMsg>;
type Data = Record<string, unknown>;
const optionalText = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';

/** 校验传统信令字段后再进入房间状态机，不对外部对象做字符串转换。 */
export function decodeSignalingClient(value: unknown): SignalingCommand | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Data;
  switch (data.t) {
    case 'create':
      return optionalText(data.room) && optionalText(data.name)
        ? { t: data.t, ...(data.room !== undefined ? { room: data.room } : {}),
          ...(data.name !== undefined ? { name: data.name } : {}) } : null;
    case 'join':
      return typeof data.room === 'string' && optionalText(data.name)
        ? { t: data.t, room: data.room, ...(data.name !== undefined ? { name: data.name } : {}) } : null;
    case 'resume':
      return typeof data.room === 'string' && typeof data.peerId === 'string' && typeof data.token === 'string'
        ? { t: data.t, room: data.room, peerId: data.peerId, token: data.token } : null;
    case 'signal': return 'data' in data ? { t: data.t, data: data.data } : null;
    case 'leave': return { t: data.t };
    case 'ping':
      if (data.ts === undefined) return { t: data.t };
      return typeof data.ts === 'number' && Number.isFinite(data.ts) ? { t: data.t, ts: data.ts } : null;
    default: return null;
  }
}
