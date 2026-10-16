import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ClientSignalingMsg,
  ServerSignalingMsg,
} from '@webrtc-gomoku/shared';
import { RoomRegistry, type LeaveResult, type RoomClient } from './rooms';

interface ExtendedWebSocket extends WebSocket {
  __id?: string;
  isAlive?: boolean;
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// 静态资源搜索目录：优先 packages/web/dist，其次 dist 或 public
const CANDIDATE_DIRS = [
  path.resolve(__dirname, '../../web/dist'),
  path.resolve(process.cwd(), 'packages/web/dist'),
  path.resolve(process.cwd(), 'dist'),
  path.resolve(process.cwd(), 'public'),
];

let PUBLIC_DIR = CANDIDATE_DIRS.find((d) => fs.existsSync(d)) || CANDIDATE_DIRS[CANDIDATE_DIRS.length - 1]!;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

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
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: registry.roomCount, uptime: Math.round(process.uptime()) }));
    return;
  }

  // 动态感知新构建的目录
  for (const d of CANDIDATE_DIRS) {
    if (fs.existsSync(d)) {
      PUBLIC_DIR = d;
      break;
    }
  }

  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback to index.html if file not found and doesn't have extension
      if (!path.extname(rel)) {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexPath, (idxErr, idxData) => {
          if (idxErr) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(idxData);
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

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
