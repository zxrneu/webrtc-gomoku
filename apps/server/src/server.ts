import http from 'node:http';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ClientSignalingMsg,
  ServerSignalingMsg,
} from '@webrtc-gomoku/shared';
import { RoomRegistry, type LeaveResult, type RoomClient } from './rooms';
import { createHttpHandler, getCandidateDirs } from './http';

interface ExtendedWebSocket extends WebSocket {
  __id?: string;
  isAlive?: boolean;
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const registry = new RoomRegistry();

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function send(ws: ExtendedWebSocket, msg: ServerSignalingMsg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** 把 ws 适配成注册表需要的最小契约（接口隔离） */
function asClient(ws: ExtendedWebSocket): RoomClient {
  return { id: ws.__id!, send: (msg) => send(ws, msg) };
}

function logLeave(result: LeaveResult) {
  if (!result.code) return;
  if (result.destroyed) {
    log(`房间 ${result.code} 已销毁`);
  } else {
    log(`房间 ${result.code} 剩余 ${result.remaining} 人`);
  }
}

/* ---------------- HTTP 静态文件 + 健康检查 ---------------- */
const candidateDirs = getCandidateDirs();
const server = http.createServer(createHttpHandler({ registry, candidateDirs }));

/* ---------------- WebSocket 信令 ---------------- */
const wss = new WebSocketServer({ server, path: '/signal' });

wss.on('connection', (socket: WebSocket) => {
  const ws = socket as ExtendedWebSocket;
  ws.__id = Math.random().toString(36).slice(2, 10);
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg: ClientSignalingMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientSignalingMsg;
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'create': {
        const res = registry.create(String(msg.room || '').toUpperCase(), asClient(ws));
        if (res.ok && res.left) logLeave(res.left);
        if (!res.ok) return send(ws, { t: 'error', message: res.message });
        send(ws, { t: 'created', room: res.code, peerId: ws.__id! });
        log(`房间 ${res.code} 创建 (peer ${ws.__id})`);
        break;
      }
      case 'join': {
        const res = registry.join(String(msg.room || '').toUpperCase(), asClient(ws));
        if (res.ok && res.left) logLeave(res.left);
        if (!res.ok) return send(ws, { t: 'error', message: res.message });
        send(ws, { t: 'joined', room: res.code, peerId: ws.__id! });
        const name = String(msg.name || '').slice(0, 20);
        for (const peer of registry.others(res.code, ws.__id!)) {
          peer.send({ t: 'peer-joined', peerId: ws.__id!, name });
        }
        log(`peer ${ws.__id} 加入房间 ${res.code}`);
        break;
      }
      case 'signal': {
        const code = registry.roomOf(ws.__id!);
        if (!code || !msg.data) return;
        for (const peer of registry.others(code, ws.__id!)) {
          peer.send({ t: 'signal', data: msg.data });
        }
        break;
      }
      case 'leave':
        logLeave(registry.leave(ws.__id!));
        break;
      default:
        send(ws, { t: 'error', message: '未知消息类型' });
    }
  });

  const bye = () => logLeave(registry.leave(ws.__id!));
  ws.on('close', bye);
  ws.on('error', bye);
});

// 心跳：清理假死连接
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

server.listen(PORT, HOST, () => {
  log(`信令服务器已启动: http://${HOST}:${PORT}`);
  for (const ip of lanAddresses()) {
    log(`  局域网访问: http://${ip}:${PORT} （手机/其他设备用这个地址）`);
  }
  log(`  WebSocket 信令通道: ws://<地址>/signal`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('收到退出信号，正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}

export { server, wss, registry };
