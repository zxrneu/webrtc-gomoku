'use strict';
const { createRequire } = require('node:module');
const WebSocket = createRequire(require.resolve('../../apps/server/package.json'))('ws');
const { performance } = require('node:perf_hooks');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class LobbyClient {
  constructor(socket) {
    this.socket = socket; this.state = null; this.seat = null; this.bytes = 0;
    this.states = 0; this.notices = []; this.waiters = new Set(); this.closed = false;
    socket.on('message', raw => {
      this.bytes += raw.length;
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'lobby-state') { this.state = msg; this.states++; }
      if (msg.t === 'lobby-seat' || msg.t === 'created' || msg.t === 'joined') this.seat = msg;
      if (msg.t === 'lobby-notice' || msg.t === 'error') this.notices.push(msg);
      for (const waiter of [...this.waiters]) if (waiter.accept(msg)) waiter.resolve(msg);
    });
    socket.on('close', (code, reason) => { this.closed = true; this.closeCode = code; this.closeReason = reason.toString(); });
    socket.on('error', error => { this.error = error.message; });
  }
  static async connect(base, options = {}) {
    const socket = new WebSocket(base.replace(/^http/, 'ws') + '/signal', options);
    const client = new LobbyClient(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve); socket.once('error', reject);
      socket.once('unexpected-response', (_, response) => { socket.terminate(); reject(Error(`HTTP ${response.statusCode}`)); });
    });
    return client;
  }
  send(message) { this.socket.send(typeof message === 'string' ? message : JSON.stringify(message)); }
  wait(accept, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { accept, resolve: msg => { clearTimeout(timer); this.waiters.delete(waiter); resolve(msg); } };
      const timer = setTimeout(() => { this.waiters.delete(waiter); reject(Error('frame timeout')); }, timeout);
      this.waiters.add(waiter);
    });
  }
  request(message, accept, timeout) { const result = this.wait(accept, timeout); this.send(message); return result; }
  enter(id, identity = {}) {
    return this.request({ t: 'lobby-enter', name: `测试${id}`, browserId: `browser-${id}`, tabId: `tab-${id}`, ...identity },
      msg => msg.t === 'lobby-state' || msg.t === 'lobby-notice');
  }
  async ping(seq, before, timeout) {
    const start = performance.now();
    const reply = this.wait(msg => msg.t === 'pong' && msg.ts === seq, timeout);
    if (before) this.send(before);
    this.send({ t: 'ping', ts: seq }); await reply;
    return performance.now() - start;
  }
  close() { if (!this.closed) this.socket.close(); }
  terminate() { this.socket.terminate(); }
}
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2) : null;
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
};
module.exports = { LobbyClient, delay, quantiles };
