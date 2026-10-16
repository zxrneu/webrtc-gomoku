import type { ServerSignalingMsg } from '@webrtc-gomoku/shared';

/**
 * 房间成员的最小能力：注册表只需要「编号」和「发消息」。
 * 不依赖 ws 具体类型，因此可脱离真实网络单测（依赖倒置）。
 */
export interface RoomClient {
  id: string;
  send(msg: ServerSignalingMsg): void;
}

export interface LeaveResult {
  /** 离开前所在房间；不在任何房间时为 null */
  code: string | null;
  /** 离开后房间剩余人数 */
  remaining: number;
  /** 房间是否因清空而销毁 */
  destroyed: boolean;
}

export type EnterResult =
  | { ok: true; code: string; left: LeaveResult | null }
  | { ok: false; message: string };

const NOT_IN_ROOM: LeaveResult = { code: null, remaining: 0, destroyed: false };
const CODE_PATTERN = /^[A-Z0-9]{4}$/;
const MAX_CLIENTS = 2;

/**
 * 房间簿记：只负责「谁在哪个房间」与进出房间的副作用（通知对端 peer-left）。
 *
 * 铁律：**所有校验都在迁移之前完成**；校验失败一律原样保留当前房间。
 * （历史上 `join`/`create` 先退旧房再校验，导致输错房号会把玩家踢出当前房间。）
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Map<string, RoomClient>>();
  private readonly membership = new Map<string, string>();

  get roomCount(): number {
    return this.rooms.size;
  }

  roomOf(clientId: string): string | null {
    return this.membership.get(clientId) ?? null;
  }

  /** 同房间的其他成员（信令转发、peer-joined 广播用） */
  others(code: string, clientId: string): RoomClient[] {
    const room = this.rooms.get(code);
    if (!room) return [];
    return [...room.values()].filter((client) => client.id !== clientId);
  }

  create(code: string, client: RoomClient): EnterResult {
    if (!CODE_PATTERN.test(code)) {
      return { ok: false, message: '房间号需为 4 位字母或数字' };
    }
    if (this.rooms.has(code)) {
      return { ok: false, message: `房间 ${code} 已存在，请更换` };
    }
    const left = this.leave(client.id);
    this.rooms.set(code, new Map([[client.id, client]]));
    this.membership.set(client.id, code);
    return { ok: true, code, left: left.code ? left : null };
  }

  join(code: string, client: RoomClient): EnterResult {
    if (this.roomOf(client.id) === code) {
      return { ok: false, message: `你已在房间 ${code} 中` };
    }
    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, message: `房间 ${code} 不存在` };
    }
    if (room.size >= MAX_CLIENTS) {
      return { ok: false, message: '房间已满（仅支持 1v1）' };
    }
    const left = this.leave(client.id);
    // 已在目标房间的情况上面已拦截，故 leave() 不会销毁这个房间，引用依旧有效
    room.set(client.id, client);
    this.membership.set(client.id, code);
    return { ok: true, code, left: left.code ? left : null };
  }

  leave(clientId: string): LeaveResult {
    const code = this.membership.get(clientId);
    if (!code) return NOT_IN_ROOM;
    this.membership.delete(clientId);

    const room = this.rooms.get(code);
    if (!room) return NOT_IN_ROOM;
    room.delete(clientId);
    if (room.size === 0) {
      this.rooms.delete(code);
      return { code, remaining: 0, destroyed: true };
    }
    for (const peer of room.values()) {
      peer.send({ t: 'peer-left' });
    }
    return { code, remaining: room.size, destroyed: false };
  }
}
