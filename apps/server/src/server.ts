import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { LobbyService } from './lobby/service';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ServerErrorCode,
  ServerSignalingMsg,
} from '@webrtc-gomoku/shared';
import { maskRoom } from '@webrtc-gomoku/shared';
import { RoomRegistry, type LeaveResult, type RoomClient } from './rooms';
import { SeatRegistry } from './grace';
import { SeatOwners } from './seat-owners';
import { decodeSignalingClient } from './signaling-codec';
import { createHttpHandler, getCandidateDirs } from './http';

/**
 * 扩展 WebSocket 实例类型，附带连接诊断与身份标识属性
 */
interface ExtendedWebSocket extends WebSocket {
  /**
   * 会话身份标识（**可被 resume 改写**）
   * 首次连接时随机生成；resume 成功后继承旧 peerId，从而占回原座位。
   */
  __id?: string;
  /** 心跳探针保活状态标记（收到对端 pong 响应时重置为 true） */
  isAlive?: boolean;
}

/** 服务端口号：优先读取系统环境变量 PORT，缺省为 3000 */
const PORT = Number(process.env.PORT || 3000);
/** 监听网络主机：缺省 '0.0.0.0'（允许局域网其他设备如手机通过 IP 访问） */
const HOST = process.env.HOST || '0.0.0.0';

/** 座位宽限期（秒）：与 ws_idle_timeout 60s 对齐 */
const GRACE_SECS = 60;
/** 座位宽限期（毫秒） */
const GRACE_MS = GRACE_SECS * 1000;
/** 宽限回收扫描周期（毫秒） */
const SWEEP_INTERVAL_MS = 5000;

/** 全局单例：房间注册中心簿记器 */
const registry = new RoomRegistry((peerId, room) => {
  const seat = seats.promoteHost(peerId);
  lobby.promoteHost(peerId, room, seat?.name);
});
/** 全局单例：座位保持与宽限期簿记器（v1.1） */
const seats = new SeatRegistry({ graceMs: GRACE_MS });

/**
 * 座位归属：接管时永久撤销旧物理连接，阻止迟到的写操作和 close/error。
 */
const seatOwners = new SeatOwners();
const lobby = new LobbyService({ rooms: registry, now: Date.now, id: randomUUID });
const connectionsByIp = new Map<string, number>();

/**
 * 带有 ISO 时间戳的控制台格式化日志工具函数
 * （服务端唯一日志出口；禁止打印 token 与 ws 远端地址，room 一律经 maskRoom）
 */
function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * 安全信令发送辅助函数
 * 仅在 WebSocket 处于 OPEN 状态时下发 JSON 报文，杜绝连接断开时调用 send 抛出异常
 */
function send(ws: ExtendedWebSocket, msg: ServerSignalingMsg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * 把具体的 WebSocket 连接适配为注册中心需要的 RoomClient 抽象接口（接口隔离 ISP）
 */
function asClient(ws: ExtendedWebSocket): RoomClient {
  return { id: ws.__id!, send: (msg) => send(ws, msg) };
}

/**
 * 记录退房或房间销毁日志
 */
function logLeave(result: LeaveResult) {
  if (!result.code) return;
  if (result.destroyed) {
    log(`房间 ${result.code} 已销毁（成员全部离开）`);
  } else {
    log(`房间 ${result.code} 剩余 ${result.remaining} 人`);
  }
}

/**
 * 把 v1 文案映射成 v1.1 机器可读错误码（文案逐字不动，只是**追加** code 字段）。
 *
 * 未识别的文案返回 undefined —— 旧客户端只读 message，不受影响；
 * 新客户端在 code 缺失时回退到文案匹配。
 */
function errorCodeFor(message: string): ServerErrorCode | undefined {
  if (message.includes('房间号需为')) return 'ROOM_FORMAT';
  if (message.includes('已存在')) return 'ROOM_EXISTS';
  if (message.includes('不存在')) return 'ROOM_NOT_FOUND';
  if (message.includes('已满')) return 'ROOM_FULL';
  return undefined;
}

/** 发送带错误码的 error（code 缺失时只发 message，保持与 v1 完全一致） */
function sendError(ws: ExtendedWebSocket, message: string) {
  const code = errorCodeFor(message);
  if (code) {
    send(ws, { t: 'error', message, code });
    return;
  }
  send(ws, { t: 'error', message });
}

/* ============================================================================
 * 1. HTTP 静态资源服务与健康检查
 * ============================================================================ */
const candidateDirs = getCandidateDirs();
const server = http.createServer(createHttpHandler({ registry, candidateDirs, lobby: true }));

/* ============================================================================
 * 2. WebSocket WebRTC 信令中继转发管道 (/signal)
 * ============================================================================
 * 在 WebRTC 架构中，信令服务器 (Signaling Server) 并不传输对局落子流量！
 * 它的唯一使命是在两台浏览器之间充当「红娘」：
 * 交换双方的 SDP 媒体协商描述（Offer / Answer）以及 ICE 候选地址列表（Candidate）。
 * 一旦双方打洞成功建立 RTCDataChannel，信令服务器就可以功成身退，后续对局完全点对点直连。
 *
 * v1.1 增量：新增 `ping` / `resume` 两条上行指令与 `pong` / `resumed` /
 * `peer-offline` / `peer-online` 四条下行通知。**旧客户端忽略未知 `t`，不崩。**
 */
const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 65536 });

wss.on('connection', (socket: WebSocket, request) => {
  const ip = request.socket.remoteAddress ?? 'unknown';
  const total = connectionsByIp.get(ip) ?? 0;
  if (total >= 10) { socket.close(1008, '连接过多'); return; }
  connectionsByIp.set(ip, total + 1);
  socket.once('close', () => {
    const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
    if (remaining <= 0) connectionsByIp.delete(ip); else connectionsByIp.set(ip, remaining);
  });
  const ws = socket as ExtendedWebSocket;
  // 初始身份使用随机 UUID，座位接管后 ws.__id 可变，owner 始终属于原物理连接。
  const connId = randomUUID();
  const owner = { isRevoked: false };
  ws.__id = connId;
  ws.isAlive = true;

  // 监听客户端返回的心跳 pong 应答，确认连接保持活性
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  /**
   * 座位登记：create / join 成功后调用，下发凭证并记录归属连接。
   */
  function issueSeat(peerId: string, room: string, name: string, role: 'host' | 'guest'): string {
    const existing = seats.peek(peerId);
    if (existing && existing.room !== room) seats.release(peerId);
    seatOwners.claim(peerId, owner);
    return seats.issue(peerId, room, name, role, Date.now());
  }

  // 监听客户端上行的信令指令
  ws.on('message', (raw) => {
    let input: unknown;
    try {
      input = JSON.parse(raw.toString());
    } catch {
      // 容错防范：恶意或残缺的非 JSON 格式数据直接忽略
      return;
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return;
    const frame = input as Record<string, unknown>;
    if (typeof frame.t !== 'string') return;
    if (owner.isRevoked && frame.t !== 'ping') return;

    if (frame.t.startsWith('lobby-')) {
      lobby.handle({ ...asClient(ws), issueSeat: (room, name, role) => issueSeat(ws.__id!, room, name, role) }, frame);
      return;
    }
    const msg = decodeSignalingClient(frame);
    if (!msg) return sendError(ws, '未知消息类型');

    switch (msg.t) {
      // ---------------- 指令 ①：创建房间 ----------------
      case 'create': {
        const res = registry.create((msg.room ?? '').toUpperCase(), asClient(ws));
        if (res.ok && res.left) logLeave(res.left);
        if (!res.ok) return sendError(ws, res.message);
        const name = (msg.name ?? '').slice(0, 20);
        const token = issueSeat(ws.__id!, res.code, name, 'host');
        lobby.syncRoom(ws.__id!, name);
        send(ws, { t: 'created', room: res.code, peerId: ws.__id!, token });
        log(`房间 ${res.code} 创建 (peer ${ws.__id})`);
        break;
      }

      // ---------------- 指令 ②：加入房间 ----------------
      case 'join': {
        const res = registry.join((msg.room ?? '').toUpperCase(), asClient(ws));
        if (res.ok && res.left) logLeave(res.left);
        if (!res.ok) return sendError(ws, res.message);
        const name = (msg.name ?? '').slice(0, 20);
        const token = issueSeat(ws.__id!, res.code, name, 'guest');
        lobby.syncRoom(ws.__id!, name);
        send(ws, { t: 'joined', room: res.code, peerId: ws.__id!, token });

        // 广播通知房间内的对手：有新玩家加入了对局
        for (const peer of registry.others(res.code, ws.__id!)) {
          peer.send({ t: 'peer-joined', peerId: ws.__id!, name });
        }
        log(`peer ${ws.__id} 加入房间 ${res.code}`);
        break;
      }

      // ---------------- 指令 ③：透传信令数据（SDP Offer/Answer / ICE Candidate） ----------------
      case 'signal': {
        const code = registry.roomOf(ws.__id!);
        if (!code || !msg.data) return;
        // 原封不动透明转发给同房间内的对手
        for (const peer of registry.others(code, ws.__id!)) {
          peer.send({ t: 'signal', data: msg.data });
        }
        break;
      }

      // ---------------- 指令 ④：主动退出房间（不留座位） ----------------
      case 'leave': {
        seats.release(ws.__id!);
        seatOwners.release(ws.__id!);
        logLeave(registry.leave(ws.__id!));
        lobby.syncRoom(ws.__id!);
        break;
      }

      // ---------------- 指令 ⑤：应用层心跳（v1.1 增量） ----------------
      // 任何状态（未入房 / 已入房 / 宽限中）都必须立即回 pong；不校验房间、不碰 registry
      case 'ping': {
        send(ws, { t: 'pong', ts: msg.ts });
        break;
      }

      // ---------------- 指令 ⑥：占回原座位（v1.1 增量，非幂等：成功后 token 轮换） ----------------
      case 'resume': {
        if (registry.roomOf(ws.__id!)) {
          send(ws, { t: 'error', code: 'RESUME_REJECTED', message: '房间已失效，请重新加入' });
          break;
        }
        const peerId = msg.peerId;
        const reqRoom = (msg.room ?? '').toUpperCase();
        const token = msg.token;
        const result = seats.verify(peerId, reqRoom, token, Date.now());

        if (result !== 'ok') {
          log(`srv.resume.reject room=${maskRoom(reqRoom)} peerId=${peerId} graceMs=${GRACE_MS}`);
          if (result === 'invalid') {
            send(ws, { t: 'error', code: 'RESUME_TOKEN_INVALID', message: '座位凭证无效' });
          } else {
            send(ws, { t: 'error', code: 'RESUME_REJECTED', message: '房间已失效，请重新加入' });
          }
          break;
        }

        // 顺序不可换：① 新连接继承旧身份 → ② 座位重绑 → ③ 轮换 token → ④ 回 resumed → ⑤ 广播 peer-online
        lobby.rebind(ws.__id!, peerId);
        ws.__id = peerId;
        registry.rebind(peerId, asClient(ws));
        const newToken = seats.rotate(peerId, Date.now()) ?? '';
        seatOwners.claim(peerId, owner);
        const peers = registry.others(reqRoom, peerId);
        send(ws, { t: 'resumed', room: reqRoom, peerId, token: newToken,
          peerPresent: peers.length > 0, role: seats.peek(peerId)?.role });
        log(`srv.resume.ok room=${maskRoom(reqRoom)} peerId=${peerId} graceMs=${GRACE_MS}`);

        for (const peer of peers) {
          peer.send({ t: 'peer-online' });
        }
        break;
      }

      default:
        send(ws, { t: 'error', message: '未知消息类型' });
    }
  });

  /**
   * socket 断开：**不调用** `registry.leave()`（座位原样保留，ADR-7）。
   *
   * 只把座位标记为「宽限中」并向对手广播 `peer-offline`；
   * `peer-left` 只在宽限期**超时后**才由 sweep 发出（Q-A 已回签）。
   */
  const onDisconnect = () => {
    const peerId = ws.__id;
    if (!peerId) return;
    // 旧 socket 迟到的事件：座位已归属新连接，直接忽略
    if (owner.isRevoked) return;
    lobby.disconnect(peerId);

    const seat = seats.markOffline(peerId, Date.now());
    if (!seat) return; // 不在任何房间 / 已在宽限中（幂等，不重复广播）

    const code = registry.roomOf(peerId);
    if (!code) return;

    for (const peer of registry.others(code, peerId)) {
      peer.send({ t: 'peer-offline', graceSec: GRACE_SECS });
    }
    log(`srv.grace.start room=${maskRoom(code)} peerId=${peerId} graceMs=${GRACE_MS}`);
  };
  ws.on('close', onDisconnect);
  ws.on('error', onDisconnect);
});

/**
 * ============================================================================
 * 3. 僵尸/半开连接心跳清理机制 (Dead Connection Pruning)
 * ============================================================================
 * 移动端进入后台、或者电脑盖上盖子时，TCP 往往不会正常发送 FIN 包，导致服务端产生「假死连接」。
 * 每隔 30 秒向所有客户端广播 ping，若上一轮未收到 pong 则直接 terminate 强杀释放内存。
 * .unref() 避免计时器阻碍 Node.js 进程在关闭时正常退出。
 */
setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as ExtendedWebSocket;
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

/**
 * ============================================================================
 * 4. 座位宽限期回收（v1.1）
 * ============================================================================
 * 每 5s 扫一次：宽限超时的座位 → 真正 leave（复用 rooms.ts 的 peer-left 广播）。
 * .unref() 不可省，否则 Ctrl+C 会挂住。
 */
setInterval(() => lobby.flush(), 1000).unref();

setInterval(() => {
  const now = Date.now();
  for (const seat of seats.sweep(now)) {
    log(`srv.grace.expire room=${maskRoom(seat.room)} peerId=${seat.peerId} graceMs=${GRACE_MS}`);
    seatOwners.release(seat.peerId);
    logLeave(registry.leave(seat.peerId));
  }
}, SWEEP_INTERVAL_MS).unref();

/**
 * 扫描本机网卡并提取所有 IPv4 局域网地址
 * 极大提升多设备联机体验：启动时直接打印出局域网 IP，方便手机或好友输入地址
 */
function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const itf of ifaces[name] || []) {
      if (itf.family === 'IPv4' && !itf.internal) {
        out.push(itf.address);
      }
    }
  }
  return out;
}

/* ============================================================================
 * 5. 监听端口启动与控制台友好指引
 * ============================================================================ */
server.listen(PORT, HOST, () => {
  log(`信令服务器已启动: http://${HOST}:${PORT}`);
  for (const ip of lanAddresses()) {
    log(`  局域网访问: http://${ip}:${PORT} （手机/其他设备用这个地址）`);
  }
  log(`  WebSocket 信令通道: ws://<地址>/signal`);
});

/**
 * 优雅停机信号处理 (Graceful Shutdown)
 * 捕获 Ctrl+C (SIGINT) 或 Kubernetes 终止信号 (SIGTERM)，确保平稳释放端口
 */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('收到退出信号，正在平稳关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}

export { server, wss, registry, seats };
