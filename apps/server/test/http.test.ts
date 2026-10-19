import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHandler, getCandidateDirs } from '../src/http';

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function dispatchRequest(
  handler: http.RequestListener,
  reqOptions: { url: string; host?: string }
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let body = '';

    const req = {
      url: reqOptions.url,
      headers: { host: reqOptions.host || 'localhost' },
    } as unknown as http.IncomingMessage;

    const res = {
      writeHead(code: number, hdrs?: Record<string, string>) {
        statusCode = code;
        if (hdrs) Object.assign(headers, hdrs);
        return this;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) {
          body = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        }
        resolve({ statusCode, headers, body });
        return this;
      },
    } as unknown as http.ServerResponse;

    try {
      handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

describe('HTTP 静态服务与健康检查 - P0 / P1 / P2 安全与回归测试', () => {
  let tempBaseDir: string;
  let publicDir: string;
  let siblingDir: string;

  beforeAll(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gomoku-http-test-'));
    publicDir = path.join(tempBaseDir, 'dist');
    siblingDir = path.join(tempBaseDir, 'dist2');

    fs.mkdirSync(publicDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });

    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><html><body>Gomoku</body></html>');
    fs.writeFileSync(path.join(publicDir, 'app.js'), 'console.log("hello");');
    fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'SUPER_SECRET_TOKEN');
  });

  afterAll(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  describe('P0: 畸形编码防 DoS 崩溃', () => {
    it('畸形百分号编码路径（如 /%）返回 400 Bad Request 而非抛出异常崩溃', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 0 },
        publicDir,
      });

      const res = await dispatchRequest(handler, { url: '/%' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe('Bad Request');
    });

    it('畸形非法转义路径（如 /%zz）返回 400 Bad Request 而非崩溃', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 0 },
        publicDir,
      });

      const res = await dispatchRequest(handler, { url: '/%zz' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe('Bad Request');
    });
  });

  describe('P1: 静态资源目录解析', () => {
    it('getCandidateDirs 首选路径指向 packages/web/dist 而非失效的 apps/web/dist', () => {
      // 模拟从 apps/server/src 目录计算相对路径
      const mockSrcDir = '/app/workspace/apps/server/src';
      const dirs = getCandidateDirs(mockSrcDir);

      // 第一优先级必须指向 packages/web/dist
      expect(dirs[0]).toBe('/app/workspace/packages/web/dist');
      expect(dirs[0]).not.toContain('/apps/web/dist');
    });
  });

  describe('P2: 目录遍历与兄弟目录隔离安全防护', () => {
    it('普通目录穿越尝试（如 /%2e%2e%2f%2e%2e%2fetc/passwd）被拦截并返回 403 Forbidden', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 0 },
        publicDir,
      });

      const res = await dispatchRequest(handler, { url: '/%2e%2e%2f%2e%2e%2fetc/passwd' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('Forbidden');
    });

    it('与公共目录同前缀的兄弟目录访问（如 /dist vs /dist2）被拦截并返回 403 Forbidden', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 0 },
        publicDir,
      });

      // 攻击载荷：利用编码斜杠绕过 URL 规范化，测试 path.relative 对兄弟目录的拦截
      const res = await dispatchRequest(handler, { url: '/%2e%2e%2fdist2/secret.txt' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('Forbidden');
      expect(res.body).not.toContain('SUPER_SECRET_TOKEN');
    });
  });

  describe('基础功能与常规路由回归', () => {
    it('GET /healthz 返回 200 及注册表房间数和 uptime', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 3 },
        uptime: () => 12345,
        publicDir,
      });

      const res = await dispatchRequest(handler, { url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        rooms: 3,
        uptime: 12345,
      });
    });

    it('正常访问公共目录内的 index.html 返回 200 与 HTML 内容', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 0 },
        publicDir,
      });

      const res = await dispatchRequest(handler, { url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Gomoku');
    });

    it('正常访问静态资源返回正确 MIME 类型', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 0 },
        publicDir,
      });

      const res = await dispatchRequest(handler, { url: '/app.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/javascript');
      expect(res.body).toContain('hello');
    });

    it('无扩展名不存在的路径触发 SPA 回退至 index.html', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 0 },
        publicDir,
      });

      const res = await dispatchRequest(handler, { url: '/room/ABCD' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Gomoku');
    });

    it('带扩展名不存在的文件返回 404 Not Found', async () => {
      const handler = createHttpHandler({
        registry: { roomCount: 0 },
        publicDir,
      });

      const res = await dispatchRequest(handler, { url: '/missing.css' });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('Not Found');
    });
  });
});

describe('大厅能力发现', () => {
  it('未接入大厅的处理器明确不声明大厅能力', async () => {
    const result = await dispatchRequest(createHttpHandler({ registry: { roomCount: 0 } }), { url: '/config' });
    expect(JSON.parse(result.body)).toMatchObject({ capabilities: { lobby: false, invites: false } });
  });
  it('接入大厅后提供可验证的能力和期限', async () => {
    const result = await dispatchRequest(createHttpHandler({ registry: { roomCount: 0 }, lobby: true }), { url: '/config' });
    expect(JSON.parse(result.body)).toMatchObject({ capabilities: { lobby: true, invites: true },
      lobby: { inviteTimeoutSec: 30, matchTimeoutSec: 60 } });
  });
});
