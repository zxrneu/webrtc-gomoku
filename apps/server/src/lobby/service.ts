import { decodeLobbyClient, type ClientLobbyMsg, type LobbyInvite, type LobbyRoom,
  type LobbyState, type LobbyUserStatus } from '@webrtc-gomoku/shared';
import { RoomRegistry, type RoomClient } from '../rooms';

export interface LobbyClient extends RoomClient {
  issueSeat(room: string, name: string, role: 'host' | 'guest'): string;
}
interface Presence {
  client: LobbyClient;
  publicId: string;
  name: string;
  browserId: string;
  tabId: string;
  ready: boolean;
  query: string;
  onlyAvailable: boolean;
  offset: number;
  lastInvite: number;
  lastRoomAction: number;
}
interface Invitation { id: string; from: string; to: string; expiresAt: number }
interface RoomInfo { host: string; name: string; public: boolean; createdAt: number }
interface Options { rooms: RoomRegistry; now(): number; id(): string }

/** 无 IO 的大厅会话协调：邀请和匹配共用既有房间注册表。 */
export class LobbyService {
  private readonly people = new Map<string, Presence>();
  private readonly invites = new Map<string, Invitation>();
  private readonly queue = new Map<string, number>();
  private readonly roomInfo = new Map<string, RoomInfo>();
  private readonly cooldown = new Map<string, number>();
  private revision = 0;
  private roomSequence = 0;

  constructor(private readonly options: Options) {}

  handle(client: LobbyClient, input: unknown): void {
    const msg = decodeLobbyClient(input);
    if (!msg) { this.notice(client, 'INVALID_NAME', '昵称需 2–12 个字符，不能含特殊符号'); return; }
    this.expire();
    if (msg.t === 'lobby-enter') this.enter(client, msg);
    else {
      const p = this.people.get(client.id);
      if (!p) { this.notice(client, 'NOT_ENTERED', '请先进入大厅'); return; }
      this.act(p, msg);
    }
    this.revision++;
    const state = this.snapshot(client.id);
    if (state) client.send(state);
  }

  private enter(client: LobbyClient, msg: Extract<ClientLobbyMsg, { t: 'lobby-enter' }>): void {
    if (this.people.has(client.id)) return;
    const previous = [...this.people.entries()].find(([, p]) => p.browserId === msg.browserId && p.tabId === msg.tabId);
    if (previous) this.disconnect(previous[0]);
    const sameBrowser = [...this.people.values()].filter(p => p.browserId === msg.browserId);
    if (sameBrowser.length >= 2) { this.notice(client, 'SESSION_LIMIT', '同一浏览器最多 2 桌'); return; }
    if (this.people.size >= 2000) { this.notice(client, 'LIMIT', '大厅已满，稍后再试'); return; }
    this.people.set(client.id, { client, publicId: this.options.id(), name: this.uniqueName(msg.name),
      browserId: msg.browserId, tabId: msg.tabId, ready: false, query: '', onlyAvailable: false,
      offset: 0, lastInvite: -Infinity, lastRoomAction: -Infinity });
  }

  private uniqueName(wanted: string, ownId?: string): string {
    const names = new Set([...this.people.entries()].filter(([id]) => id !== ownId).map(([, p]) => p.name));
    if (!names.has(wanted)) return wanted;
    for (let n = 2; n <= 2002; n++) {
      const suffix = String(n);
      const name = [...wanted].slice(0, 12 - suffix.length).join('') + suffix;
      if (!names.has(name)) return name;
    }
    return `棋友${this.options.id().replace(/[^a-z0-9]/gi, '').slice(-8)}`;
  }

  private act(p: Presence, msg: Exclude<ClientLobbyMsg, { t: 'lobby-enter' }>): void {
    switch (msg.t) {
      case 'lobby-list':
        p.query = msg.query ?? ''; p.onlyAvailable = msg.onlyAvailable ?? false; p.offset = msg.offset ?? 0; break;
      case 'lobby-name': p.name = this.uniqueName(msg.name, p.client.id); this.syncRoom(p.client.id, p.name); break;
      case 'lobby-invite': this.invite(p, msg.target); break;
      case 'lobby-respond': this.respond(p, msg); break;
      case 'lobby-cancel': {
        const invitation = this.invites.get(msg.id);
        if (invitation?.from === p.client.id) this.endInvite(invitation, 'CANCELLED', '邀请已取消');
        break;
      }
      case 'lobby-match': this.match(p, msg.action); break;
      case 'lobby-create': this.create(p, msg.public); break;
      case 'lobby-join': this.join(p, msg.room); break;
      case 'lobby-visibility': {
        const info = this.roomInfo.get(this.options.rooms.roomOf(p.client.id) ?? '');
        if (info?.host === p.client.id) info.public = msg.public;
        break;
      }
      case 'lobby-ready':
        p.ready = msg.ready;
        if (p.ready && !this.options.rooms.roomOf(p.client.id)) this.interrupt(p.client.id);
        break;
      default: { const exhaustive: never = msg; return exhaustive; }
    }
  }

  private pending(id: string): Invitation | undefined {
    return [...this.invites.values()].find(i => i.from === id || i.to === id);
  }

  private status(id: string): LobbyUserStatus {
    const code = this.options.rooms.roomOf(id);
    if (code) {
      const members = this.options.rooms.others(code, '');
      if (members.length === 1) return 'waiting';
      return members.every(c => this.people.get(c.id)?.ready) ? 'playing' : 'connecting';
    }
    if (this.people.get(id)?.ready) return 'playing';
    if (this.queue.has(id)) return 'matching';
    if (this.pending(id)) return 'inviting';
    return 'idle';
  }

  private invite(from: Presence, target: string): void {
    const to = [...this.people.values()].find(p => p.publicId === target);
    if (!to || to === from) { this.notice(from.client, 'TARGET_OFFLINE', '对方已离线或无法邀请'); return; }
    const prior = this.pending(from.client.id);
    if (prior && [prior.from, prior.to].includes(to.client.id)) return;
    if (this.status(from.client.id) !== 'idle' || this.status(to.client.id) !== 'idle') {
      this.notice(from.client, 'BUSY', '对方当前忙碌，暂时无法接受邀请'); return;
    }
    const now = this.options.now();
    if (now - from.lastInvite < 3000 || (this.cooldown.get(this.pairKey(from.client.id, to.client.id)) ?? 0) > now) {
      this.notice(from.client, 'RATE_LIMITED', '操作太快了，休息一下'); return;
    }
    from.lastInvite = now;
    const invitation = { id: this.options.id(), from: from.client.id, to: to.client.id, expiresAt: now + 30000 };
    this.invites.set(invitation.id, invitation);
  }

  private respond(p: Presence, msg: Extract<ClientLobbyMsg, { t: 'lobby-respond' }>): void {
    const invitation = this.invites.get(msg.id);
    if (!invitation || invitation.to !== p.client.id) return;
    const from = this.people.get(invitation.from);
    if (!msg.accept) { this.endInvite(invitation, 'DECLINED', '对方暂时不方便'); return; }
    if (!from || this.options.rooms.roomOf(from.client.id) || this.options.rooms.roomOf(p.client.id) ||
      this.queue.has(from.client.id) || this.queue.has(p.client.id)) {
      this.endInvite(invitation, 'BUSY', '对方当前忙碌，暂时无法接受邀请'); return;
    }
    this.invites.delete(invitation.id);
    this.pair(from, p);
  }

  private pairKey(a: string, b: string): string { return [a, b].sort().join(':'); }

  private endInvite(i: Invitation, code: string, message: string): void {
    this.invites.delete(i.id);
    if (code === 'DECLINED' || code === 'EXPIRED') this.cooldown.set(this.pairKey(i.from, i.to), this.options.now() + 60000);
    for (const id of [i.from, i.to]) {
      const p = this.people.get(id);
      if (p) this.notice(p.client, code, message);
    }
  }

  private interrupt(id: string): void {
    this.queue.delete(id);
    const i = this.pending(id);
    if (i) this.endInvite(i, 'CANCELLED', '邀请已结束');
  }

  private match(p: Presence, action: 'join' | 'leave'): void {
    const id = p.client.id;
    if (action === 'leave') { this.queue.delete(id); return; }
    if (this.queue.has(id)) return;
    if (p.ready) { this.notice(p.client, 'BUSY', '请先结束手动信令会话'); return; }
    if (this.options.rooms.roomOf(id)) { this.notice(p.client, 'BUSY', '请先退出当前房间'); return; }
    const invitation = this.pending(id);
    if (invitation?.from === id) { this.notice(p.client, 'BUSY', '请先取消邀请'); return; }
    this.interrupt(id);
    const otherId = this.queue.keys().next().value as string | undefined;
    const other = otherId ? this.people.get(otherId) : undefined;
    if (other) { this.queue.delete(other.client.id); this.pair(other, p); }
    else this.queue.set(id, this.options.now());
  }

  private nextRoom(): string | null {
    if (this.options.rooms.roomCount >= 1000) return null;
    for (let n = 0; n < 100; n++) {
      // 房号是公开寻址信息，不是权限凭证；座位凭证由独立 issueSeat 签发。
      const code = (++this.roomSequence % 1679616).toString(36).toUpperCase().padStart(4, '0');
      if (this.options.rooms.others(code, '').length === 0) return code;
    }
    return null;
  }

  private pair(host: Presence, guest: Presence): void {
    const code = this.nextRoom();
    if (!code) {
      for (const p of [host, guest]) this.notice(p.client, 'LIMIT', '大厅已满，稍后再试');
      return;
    }
    const created = this.options.rooms.create(code, host.client);
    if (!created.ok) return;
    const joined = this.options.rooms.join(code, guest.client);
    if (!joined.ok) { this.options.rooms.leave(host.client.id); return; }
    this.roomInfo.set(code, { host: host.client.id, name: host.name, public: false, createdAt: this.options.now() });
    this.queue.delete(host.client.id); this.queue.delete(guest.client.id);
    this.seat(host, code, 'host'); this.seat(guest, code, 'guest');
    host.client.send({ t: 'peer-joined', peerId: guest.client.id, name: guest.name });
  }

  private seat(p: Presence, code: string, role: 'host' | 'guest'): void {
    p.ready = false;
    const token = p.client.issueSeat(code, p.name, role);
    p.client.send({ t: 'lobby-seat', room: code, role, peerId: p.client.id, token });
  }

  private canEnter(p: Presence): boolean {
    if (p.ready || this.options.rooms.roomOf(p.client.id) || this.queue.has(p.client.id) || this.pending(p.client.id)?.from === p.client.id) {
      this.notice(p.client, 'BUSY', '请先退出当前房间、匹配或邀请'); return false;
    }
    if (this.options.now() - p.lastRoomAction < 3000) {
      this.notice(p.client, 'RATE_LIMITED', '操作太快了，休息一下'); return false;
    }
    return true;
  }

  private create(p: Presence, isPublic: boolean): void {
    if (!this.canEnter(p)) return;
    const code = this.nextRoom();
    if (!code) { this.notice(p.client, 'LIMIT', '大厅已满，稍后再试'); return; }
    const res = this.options.rooms.create(code, p.client);
    if (!res.ok) { this.notice(p.client, 'BUSY', res.message); return; }
    this.interrupt(p.client.id); p.lastRoomAction = this.options.now();
    this.roomInfo.set(code, { host: p.client.id, name: p.name, public: isPublic, createdAt: this.options.now() });
    this.seat(p, code, 'host');
  }

  private join(p: Presence, code: string): void {
    if (!this.canEnter(p)) return;
    const info = this.roomInfo.get(code);
    if (!info?.public || !this.people.has(info.host)) {
      this.notice(p.client, 'ROOM_NOT_FOUND', '房间不存在或房主已离线'); return;
    }
    const res = this.options.rooms.join(code, p.client);
    if (!res.ok) { this.notice(p.client, 'ROOM_FULL', res.message); return; }
    this.interrupt(p.client.id); p.lastRoomAction = this.options.now();
    this.seat(p, code, 'guest');
    for (const peer of this.options.rooms.others(code, p.client.id)) {
      peer.send({ t: 'peer-joined', peerId: p.client.id, name: p.name });
    }
  }

  syncRoom(id: string, name?: string): void {
    this.interrupt(id);
    const code = this.options.rooms.roomOf(id);
    if (!code) return;
    const info = this.roomInfo.get(code);
    if (!info) this.roomInfo.set(code, { host: id, name: name ?? this.people.get(id)?.name ?? '棋友',
      public: false, createdAt: this.options.now() });
    else if (info.host === id && name) info.name = name;
    this.revision++;
  }

  rebind(previous: string, restored: string): void {
    const p = this.people.get(previous);
    if (!p) return;
    this.people.delete(previous); p.client = { ...p.client, id: restored };
    this.people.set(restored, p); this.revision++;
  }

  disconnect(id: string): void {
    this.interrupt(id); this.people.delete(id); this.revision++;
  }

  private expire(): void {
    const now = this.options.now();
    for (const i of this.invites.values()) if (now >= i.expiresAt) this.endInvite(i, 'EXPIRED', '邀请已过期');
    for (const [id, since] of this.queue) if (now - since >= 60000) {
      this.queue.delete(id); const p = this.people.get(id);
      if (p) this.notice(p.client, 'MATCH_TIMEOUT', '暂时没找到对手，试试自己开一桌？');
    }
    for (const [key, until] of this.cooldown) if (now >= until) this.cooldown.delete(key);
    for (const code of this.roomInfo.keys()) if (this.options.rooms.others(code, '').length === 0) this.roomInfo.delete(code);
  }

  flush(): void {
    this.expire(); this.revision++;
    for (const id of this.people.keys()) {
      const snapshot = this.snapshot(id);
      if (snapshot) this.people.get(id)?.client.send(snapshot);
    }
  }

  private publicRooms(): LobbyRoom[] {
    const result: LobbyRoom[] = [];
    for (const [code, info] of this.roomInfo) {
      if (!info.public || !this.options.rooms.has(info.host)) continue;
      result.push({ code, name: info.name, count: this.options.rooms.others(code, '').length,
        status: !this.people.has(info.host) ? 'offline' : this.status(info.host) === 'waiting' ? 'waiting' :
          this.status(info.host) === 'playing' ? 'playing' : 'connecting', createdAt: info.createdAt });
    }
    return result.sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') ||
      a.createdAt - b.createdAt || a.code.localeCompare(b.code));
  }

  snapshot(id: string): LobbyState | null {
    const p = this.people.get(id);
    if (!p) return null;
    const users = [...this.people.values()].map(person => ({ id: person.publicId, name: person.name,
      status: this.status(person.client.id) })).filter(u => u.name.toLowerCase().includes(p.query.toLowerCase()) &&
        (!p.onlyAvailable || u.status === 'idle'))
      .sort((a, b) => Number(b.status === 'idle') - Number(a.status === 'idle') || a.id.localeCompare(b.id));
    const rooms = this.publicRooms();
    const code = this.options.rooms.roomOf(id);
    const info = code ? this.roomInfo.get(code) : null;
    const i = this.pending(id);
    const from = i ? this.people.get(i.from) : null;
    const to = i ? this.people.get(i.to) : null;
    const invitation: LobbyInvite | null = i && from && to ? { id: i.id,
      from: { id: from.publicId, name: from.name }, to: { id: to.publicId, name: to.name }, expiresAt: i.expiresAt } : null;
    const since = this.queue.get(id);
    return { t: 'lobby-state', selfId: p.publicId, name: p.name, online: this.people.size,
      waiting: rooms.filter(r => r.status === 'waiting').length, users: users.slice(p.offset, p.offset + 20),
      totalUsers: users.length, rooms: rooms.slice(0, 100), totalRooms: rooms.length,
      room: code ? { code, public: info?.public ?? false, role: info?.host === id ? 'host' : 'guest' } : null,
      invite: invitation, match: since !== undefined ? { since, expiresAt: since + 60000 } : null,
      serverNow: this.options.now(), revision: this.revision };
  }

  private notice(client: RoomClient, code: string, message: string): void {
    client.send({ t: 'lobby-notice', code, message });
  }
}
