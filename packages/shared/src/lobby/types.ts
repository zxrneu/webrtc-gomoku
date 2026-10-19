/** 大厅只交换可发现身份、入座和邀请状态，不携带棋谱与网络候选。 */
export type LobbyUserStatus = 'idle' | 'matching' | 'inviting' | 'waiting' | 'connecting' | 'playing';
export interface LobbyUser { id: string; name: string; status: LobbyUserStatus }
export interface LobbyRoom {
  code: string;
  name: string;
  count: number;
  status: 'waiting' | 'connecting' | 'playing' | 'offline';
  createdAt: number;
}
export interface LobbyInvite {
  id: string;
  from: { id: string; name: string };
  to: { id: string; name: string };
  expiresAt: number;
}
export interface LobbyOwnRoom { code: string; public: boolean; role: 'host' | 'guest' }
export interface LobbyMatch { since: number; expiresAt: number }
export interface LobbyState {
  t: 'lobby-state';
  selfId: string;
  name: string;
  online: number;
  waiting: number;
  users: LobbyUser[];
  totalUsers: number;
  rooms: LobbyRoom[];
  totalRooms: number;
  room: LobbyOwnRoom | null;
  invite: LobbyInvite | null;
  match: LobbyMatch | null;
  serverNow: number;
  revision: number;
}
export interface LobbySeat { t: 'lobby-seat'; room: string; role: 'host' | 'guest'; peerId: string; token: string }
export interface LobbyNotice { t: 'lobby-notice'; code: string; message: string }
export type ServerLobbyMsg = LobbyState | LobbySeat | LobbyNotice;
export type ClientLobbyMsg =
  | { t: 'lobby-enter'; name: string; browserId: string; tabId: string }
  | { t: 'lobby-list'; query?: string; onlyAvailable?: boolean; offset?: number }
  | { t: 'lobby-name'; name: string }
  | { t: 'lobby-invite'; target: string }
  | { t: 'lobby-respond'; id: string; accept: boolean }
  | { t: 'lobby-cancel'; id: string }
  | { t: 'lobby-match'; action: 'join' | 'leave' }
  | { t: 'lobby-create'; public: boolean }
  | { t: 'lobby-join'; room: string }
  | { t: 'lobby-visibility'; public: boolean }
  | { t: 'lobby-ready'; ready: boolean };
