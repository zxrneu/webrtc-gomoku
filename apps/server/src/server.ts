import http from 'node:http';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ClientSignalingMsg,
  ServerSignalingMsg,
} from '@webrtc-gomoku/shared';
import { RoomRegistry, type LeaveResult, type RoomClient } from './rooms';
import { createHttpHandler, getCandidateDirs } from './http';

/**
 * 扩展 WebSocket 实例类型，附带连接诊断与身份标识属性
 */
interface ExtendedWebSocket extends WebSocket {
  /** 服务器为该物理长连接分配的临时唯一标识 ID */
  __id?: string;
  /** 心跳探针保活状态标记（收到对端 pong 响应时重置为 true） */
  isAlive?: boolean;
}

/** 服务端口号：优先读取系统环境变量 PORT，缺省为 3000 */
const PORT = Number(process.env.PORT || 3000);
/** 监听网络主机：缺省 '0.0.0.0'（允许局域网其他设备如手机通过 IP 访问） */
const HOST = process.env.HOST || '0.0.0.0';

/** 全局单例：房间注册中心簿记器 */
const registry = new RoomRegistry();

/**
 * 带有 ISO 时间戳的控制台格式化日志工具函数
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

/* ============================================================================
 * 1. HTTP 静态资源服务与健康检查
 * ============================================================================ */
const candidateDirs = getCandidateDirs();
const server = http.createServer(createHttpHandler({ registry, candidateDirs }));

/* ============================================================================
 * 2. WebSocket WebRTC 信令中继转发管道 (/signal)
 * ============================================================================
 * 在 WebRTC 架构中，信令服务器 (Signaling Server) 并不传输对局落子流量！
 * 它的唯一使命是在两台浏览器之间充当「红娘」：
 * 交换双方的 SDP 媒体协商描述（Offer / Answer）以及 ICE 候选地址列表（Candidate）。
 * 一旦双方打洞成功建立 RTCDataChannel，信令服务器就可以功成身退，后续对局完全点对点直连。
 */
const wss = new WebSocketServer({ server, path: '/signal' });

wss.on('connection', (socket: WebSocket) => {
  const ws = socket as ExtendedWebSocket;
  // 随机生成 8 位字符串作为客户端物理连接的唯一 Peer ID
  ws.__id = Math.random().toString(36).slice(2, 10);
  ws.isAlive = true;

  // 监听客户端返回的心跳 pong 应答，确认连接保持活性
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // 监听客户端上行的信令指令
  ws.on('message', (raw) => {
    let msg: ClientSignalingMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientSignalingMsg;
    } catch {
      // 容错防范：恶意或残缺的非 JSON 格式数据直接忽略
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      // ---------------- 指令 ①：创建房间 ----------------
      case 'create': {
        const res = registry.create(String(msg.room || '').toUpperCase(), asClient(ws));
        if (res.ok && res.left) logLeave(res.left);
        if (!res.ok) return send(ws, { t: 'error', message: res.message });
        send(ws, { t: 'created', room: res.code, peerId: ws.__id! });
        log(`房间 ${res.code} 创建 (peer ${ws.__id})`);
        break;
      }

      // ---------------- 指令 ②：加入房间 ----------------
      case 'join': {
        const res = registry.join(String(msg.room || '').toUpperCase(), asClient(ws));
        if (res.ok && res.left) logLeave(res.left);
        if (!res.ok) return send(ws, { t: 'error', message: res.message });
        send(ws, { t: 'joined', room: res.code, peerId: ws.__id! });
        
        // 广播通知房间内的对手：有新玩家加入了对局
        const name = String(msg.name || '').slice(0, 20);
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

      // ---------------- 指令 ④：主动退出房间 ----------------
      case 'leave':
        logLeave(registry.leave(ws.__id!));
        break;

      default:
        send(ws, { t: 'error', message: '未知消息类型' });
    }
  });

  // 当网络断开或发生异常时，自动清理退房并通知房间内的对手
  const bye = () => logLeave(registry.leave(ws.__id!));
  ws.on('close', bye);
  ws.on('error', bye);
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
 * 4. 监听端口启动与控制台友好指引
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

export { server, wss, registry };
