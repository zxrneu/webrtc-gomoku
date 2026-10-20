import type { ServerSignalingMsg } from '@webrtc-gomoku/shared';

/**
 * ============================================================================
 * 房间客户端最小契约接口 (DIP 依赖反转原则与 ISP 接口隔离原则)
 * ============================================================================
 * 房间注册表在管理成员时，实际上只需要两项能力：
 * 1. 知道这个客户端是谁 (`id: string`)
 * 2. 能够给这个客户端发信令 (`send: (msg) => void`)
 * 
 * 为什么不直接 import { WebSocket } from 'ws'？
 * - 如果强耦合 ws 类型，单元测试必须启动真实的网络端口、建立真的 TCP/WS 连接；
 * - 抽象出这个接口后，单测只需要传入 `{ id: 'client-1', send: vi.fn() }` 这种假对象，
 *   即可在毫秒级无网环境下进行高频、确定性的纯内存逻辑测试！
 */
export interface RoomClient {
  /** 客户端唯一标识 ID (如随机生成的 8 位 hash) */
  id: string;
  /** 发送服务端信令消息的方法 */
  send(msg: ServerSignalingMsg): void;
}

/**
 * 玩家离开房间后的状态变更快照
 */
export interface LeaveResult {
  /** 离开前所在的房间号；若原本就不在任何房间则为 null */
  code: string | null;
  /** 玩家离开后，该房间剩余的玩家人数 */
  remaining: number;
  /** 房间是否因为人去楼空 (人数归零) 而被自动注销销毁 */
  destroyed: boolean;
}

/**
 * 进入/创建房间操作的执行结果（采用 TypeScript 判别联合类型）
 * 成功返回 { ok: true, code, left }，失败返回明确原因 { ok: false, message }
 */
export type EnterResult =
  | { ok: true; code: string; left: LeaveResult | null }
  | { ok: false; message: string };

/** 初始空状态对象：表示用户未加入过任何房间 */
const NOT_IN_ROOM: LeaveResult = { code: null, remaining: 0, destroyed: false };
/** 房间号格式正则约束：必须恰好为 4 位大写字母或数字 (如 "A8B2") */
const CODE_PATTERN = /^[A-Z0-9]{4}$/;
/** 五子棋对局人数上限：严格限制为 2 人 (1v1 纯双人对战) */
const MAX_CLIENTS = 2;

/**
 * ============================================================================
 * 房间注册中心簿记器 (RoomRegistry)
 * ============================================================================
 * 职责：
 * 维护内存中「谁在哪个房间」的双向索引映射，以及进出房间的状态机迁移。
 * 
 * 核心架构铁律：【所有校验都在数据状态迁移之前完成】！
 * - 严禁先让玩家退出旧房间，再去校验新房间号合不合法；
 * - 否则一旦玩家输错了一个不存在的房间号，就会导致原本正常的旧对局被意外退房踢掉。
 */
export class RoomRegistry {
  constructor(private readonly onPromote: (clientId: string, room: string) => void = () => {}) {}

  /** 
   * 正向索引映射表：roomCode -> Map<clientId, RoomClient>
   * 记录每个房间号下当前在线的玩家列表
   */
  private readonly rooms = new Map<string, Map<string, RoomClient>>();

  /** 
   * 反向索引映射表：clientId -> roomCode
   * O(1) 复杂度瞬间查询某个客户端当前所在哪个房间，避免全表扫描
   */
  private readonly membership = new Map<string, string>();

  /**
   * 当前存活的活跃房间总数（用于 /healthz 健康探针和监控大盘）
   */
  get roomCount(): number {
    return this.rooms.size;
  }

  /**
   * 查询指定客户端当前所在房间号
   */
  roomOf(clientId: string): string | null {
    return this.membership.get(clientId) ?? null;
  }

  /**
   * 该客户端当前是否仍占着房间座位（v1.1 座位保持用）
   *
   * 宽限期内 socket 已断但座位仍在 → 返回 true；真正 leave 后 → false。
   */
  has(clientId: string): boolean {
    return this.membership.has(clientId);
  }

  /**
   * 把座位重绑到新的连接对象（v1.1 resume 成功后调用）
   *
   * 【为什么不需要动房间结构】：
   * `rooms` 本身就是「座位表」——断线时不删条目，座位就在；
   * 恢复时只需把 `send` 目标换成新连接，房间成员数、对手关系全部不变。
   *
   * @param clientId 座位主键（= 旧连接的 peerId，重连后由新连接继承）
   * @param client 新连接适配出的 RoomClient
   * @returns 座位存在且重绑成功返回 true
   */
  rebind(clientId: string, client: RoomClient): boolean {
    const code = this.membership.get(clientId);
    if (!code) return false;
    const room = this.rooms.get(code);
    if (!room || !room.has(clientId)) return false;
    room.set(clientId, client);
    return true;
  }

  /**
   * 获取同房间内的其他对手成员（用于转发 SDP、ICE 候选及广播对端加入通知）
   * @param code 房间号
   * @param clientId 排除当前客户端自己的 ID
   * @returns 对手客户端列表（五子棋 1v1 中最多包含 1 个对手）
   */
  others(code: string, clientId: string): RoomClient[] {
    const room = this.rooms.get(code);
    if (!room) return [];
    return [...room.values()].filter((client) => client.id !== clientId);
  }

  /**
   * 创建全新房间
   * 流程：
   * 1. 校验房间号格式 (4 位大写字母/数字)
   * 2. 校验房间号唯一性 (不可重复创建已有房间)
   * 3. 若原本在别的房间，原子性退出旧房间
   * 4. 登记新房间与成员映射
   */
  create(code: string, client: RoomClient): EnterResult {
    if (!CODE_PATTERN.test(code)) {
      return { ok: false, message: '房间号需为 4 位字母或数字' };
    }
    if (this.rooms.has(code)) {
      return { ok: false, message: `房间 ${code} 已存在，请更换` };
    }
    // 前置校验全部通过后，方可执行旧房间退订
    const left = this.leave(client.id);
    this.rooms.set(code, new Map([[client.id, client]]));
    this.membership.set(client.id, code);
    return { ok: true, code, left: left.code ? left : null };
  }

  /**
   * 加入已有房间
   * 流程：
   * 1. 防重复校验：不能重复加入已在的同一个房间
   * 2. 存在性校验：目标房间必须存在
   * 3. 容量校验：房间人数未达上限 (<= 2)
   * 4. 退出旧房间并登记录入新房间
   */
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
    // 前置校验全部满足后，退出旧房间并迁移
    const left = this.leave(client.id);
    room.set(client.id, client);
    this.membership.set(client.id, code);
    return { ok: true, code, left: left.code ? left : null };
  }

  /**
   * 退出房间（支持显式主动 leave 或连接断开被动触发）
   * 流程：
   * 1. 解绑反向映射 membership
   * 2. 从房间移除该成员
   * 3. 若房间人数变为 0，自动回收销毁房间，杜绝内存泄漏
   * 4. 若房间还有其他对手，主动推送 { t: 'peer-left' } 通知对端
   */
  leave(clientId: string): LeaveResult {
    const code = this.membership.get(clientId);
    if (!code) return NOT_IN_ROOM;
    this.membership.delete(clientId);

    const room = this.rooms.get(code);
    if (!room) return NOT_IN_ROOM;
    room.delete(clientId);

    // 房间清空时自动销毁
    if (room.size === 0) {
      this.rooms.delete(code);
      return { code, remaining: 0, destroyed: true };
    }

    // 房间还有对手在场时，向对手广播其已离线离开的消息
    for (const peer of room.values()) {
      this.onPromote(peer.id, code);
      peer.send({ t: 'peer-left', role: 'host' });
    }
    return { code, remaining: room.size, destroyed: false };
  }
}
