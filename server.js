'use strict';
/**
 * WebRTC 五子棋 - 信令 + 静态文件服务器
 * 服务器只做两件事：托管静态页面、按房间中转 WebRTC 信令（offer/answer/ice）。
 * 棋局数据全部走浏览器之间的 DataChannel，不经过服务器。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** @type {Map<string, Map<string, import('ws').WebSocket>>} 房间号 -> 成员 */
const rooms = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function leaveRoom(ws) {
  const code = ws.__room;
  if (!code) return;
  const room = rooms.get(code);
  ws.__room = null;
  if (!room) return;
  room.delete(ws.__id);
  if (room.size === 0) {
    rooms.delete(code);
    log(`房间 ${code} 已销毁`);
  } else {
    for (const peer of room.values()) send(peer, { t: 'peer-left' });
    log(`房间 ${code} 剩余 ${room.size} 人`);
  }
}

/* ---------------- 静态文件 + 健康检查 ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
    return;
  }

  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
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

wss.on('connection', (ws) => {
  ws.__id = Math.random().toString(36).slice(2, 10);
  ws.__room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'create': {
        if (ws.__room) leaveRoom(ws); // 防止重复建房留下幽灵房间
        const code = String(msg.room || '').toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code)) {
          return send(ws, { t: 'error', message: '房间号需为 4 位字母或数字' });
        }
        if (rooms.has(code)) {
          return send(ws, { t: 'error', message: `房间 ${code} 已存在，请更换` });
        }
        rooms.set(code, new Map([[ws.__id, ws]]));
        ws.__room = code;
        send(ws, { t: 'created', room: code, peerId: ws.__id });
        log(`房间 ${code} 创建 (peer ${ws.__id})`);
        break;
      }
      case 'join': {
        if (ws.__room) leaveRoom(ws);
        const code = String(msg.room || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) return send(ws, { t: 'error', message: `房间 ${code} 不存在` });
        if (room.size >= 2) return send(ws, { t: 'error', message: '房间已满（仅支持 1v1）' });
        room.set(ws.__id, ws);
        ws.__room = code;
        send(ws, { t: 'joined', room: code, peerId: ws.__id });
        for (const [id, peer] of room) {
          if (id !== ws.__id) send(peer, { t: 'peer-joined', peerId: ws.__id, name: String(msg.name || '').slice(0, 20) });
        }
        log(`peer ${ws.__id} 加入房间 ${code}`);
        break;
      }
      case 'signal': {
        const room = rooms.get(ws.__room);
        if (!room || !msg.data) return;
        for (const [id, peer] of room) {
          if (id !== ws.__id) send(peer, { t: 'signal', data: msg.data });
        }
        break;
      }
      case 'leave':
        leaveRoom(ws);
        break;
      default:
        send(ws, { t: 'error', message: '未知消息类型' });
    }
  });

  const bye = () => leaveRoom(ws);
  ws.on('close', bye);
  ws.on('error', bye);
});

// 心跳：清理假死连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const itf of ifaces[name] || []) {
      if (itf.family === 'IPv4' && !itf.internal) out.push(itf.address);
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

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号，正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
