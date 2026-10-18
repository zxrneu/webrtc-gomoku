import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LogEvent } from '../../src/reconnect/log';
import { hostOf, maskRoom } from '../../src/reconnect/log';

describe('log · 房间号打码', () => {
  it("maskRoom('A8B2')==='A**2'", () => {
    expect(maskRoom('A8B2')).toBe('A**2');
  });

  it('maskRoom 对 null / 短串 / 长串一律返回 ****', () => {
    expect(maskRoom(null)).toBe('****');
    expect(maskRoom('')).toBe('****');
    expect(maskRoom('AB')).toBe('****');
    expect(maskRoom('ABCDEF')).toBe('****');
  });
});

describe('log · hostOf 只保留 host', () => {
  it("hostOf('wss://host:3000/signal')==='host'（丢弃端口与 path）", () => {
    expect(hostOf('wss://host:3000/signal')).toBe('host');
  });

  it('hostOf 丢弃 query 与 fragment', () => {
    expect(hostOf('https://example.com/a?token=secret#frag')).toBe('example.com');
  });

  it('hostOf 丢弃 URL 中的 userinfo（不得泄漏凭证）', () => {
    expect(hostOf('wss://user:pass@example.com:443/signal')).toBe('example.com');
  });

  it('hostOf 支持无协议头的裸地址', () => {
    expect(hostOf('localhost:3000')).toBe('localhost');
  });

  it('hostOf 对空串返回 unknown', () => {
    expect(hostOf('')).toBe('unknown');
  });

  it('hostOf 保留 IPv6 字面量的方括号', () => {
    expect(hostOf('ws://[::1]:3000/signal')).toBe('[::1]');
  });
});

describe('log · 脱敏白名单（K5）', () => {
  /** 允许出现在日志事件里的字段全集（类型上即白名单） */
  const WHITELIST = new Set([
    'ev',
    'from',
    'to',
    'attempt',
    'reason',
    'sinceMs',
    'delayMs',
    'urlHost',
    'totalMs',
    'via',
    'movesSynced',
    'online',
    'visibility',
    'server',
    'rev',
    'at',
  ]);

  const samples: LogEvent[] = [
    { ev: 'conn.state', from: 'CONNECTED', to: 'RECONNECTING', attempt: 1, reason: 'WS_CLOSED', sinceMs: 1 },
    { ev: 'conn.retry', attempt: 1, delayMs: 500, reason: 'WS_CLOSED', urlHost: 'host' },
    { ev: 'conn.restore', attempt: 1, totalMs: 1200, via: 'ice-restart', movesSynced: 0 },
    { ev: 'conn.fail', reason: 'POLICY_EXHAUSTED', attempt: 6, totalMs: 47000, online: true, visibility: 'visible' },
    { ev: 'conn.compat', server: 'v1' },
    { ev: 'conn.sync-reject', rev: 3, at: 2 },
  ];

  it('6 类日志事件的字段全部落在白名单内（SDP / candidate / IP / token 无处可放）', () => {
    for (const e of samples) {
      for (const key of Object.keys(e)) {
        expect(WHITELIST.has(key), `${e.ev} 出现非白名单字段 ${key}`).toBe(true);
      }
    }
  });

  it('日志事件序列化后不含 sdp / candidate / token 等敏感字样', () => {
    const text = JSON.stringify(samples).toLowerCase();

    expect(text).not.toContain('sdp');
    expect(text).not.toContain('candidate');
    expect(text).not.toContain('token');
    expect(text).not.toContain('password');
    expect(text).not.toContain('192.168');
  });
});

describe('log · 分层红线（结构断言）', () => {
  const dir = join(process.cwd(), 'packages/shared/src/reconnect');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  /** 去掉块注释与行注释，只检查真实代码（文档注释里出现禁用词是允许的） */
  const codeOf = (file: string): string =>
    readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

  it('shared/reconnect 下没有任何 console.* 调用', () => {
    for (const f of files) {
      expect(codeOf(f).includes('console.'), `${f} 出现 console`).toBe(false);
    }
  });

  it('shared/reconnect 下不出现 Date.now / setTimeout / setInterval 直接调用', () => {
    // 只禁止「全局」调用（clock.setTimeout 是注入接缝，允许）
    const bare = (name: string) => new RegExp(`(?<![.\\w])${name}\\s*\\(`);
    for (const f of files) {
      const code = codeOf(f);
      expect(code.includes('Date.now'), `${f} 出现 Date.now`).toBe(false);
      // ports.ts 只有 Clock 接口的方法声明（setTimeout(fn, ms): number），不是全局调用
      if (f === 'ports.ts') continue;
      expect(bare('setTimeout').test(code), `${f} 出现全局 setTimeout(`).toBe(false);
      expect(bare('setInterval').test(code), `${f} 出现全局 setInterval(`).toBe(false);
    }
  });

  it('shared/reconnect 下不出现 window / document / WebSocket / RTCPeerConnection', () => {
    for (const f of files) {
      const code = codeOf(f);
      for (const banned of ['window.', 'document.', 'new WebSocket', 'RTCPeerConnection']) {
        expect(code.includes(banned), `${f} 出现 ${banned}`).toBe(false);
      }
    }
  });

  it('shared/reconnect 下没有反向 import（不得 import web / server / App）', () => {
    for (const f of files) {
      const code = codeOf(f);
      for (const banned of ['packages/web', 'apps/server', "from '../App", 'webrtc.ts']) {
        expect(code.includes(banned), `${f} 出现反向依赖 ${banned}`).toBe(false);
      }
    }
  });
});
