import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * HTTP 请求处理器配置选项接口
 */
export interface HttpHandlerOptions {
  /** 关联的房间注册中心（只读其 roomCount 状态，用于健康检查探针） */
  registry: { readonly roomCount: number };
  /** 候选静态文件根目录列表（支持测试时注入模拟目录） */
  candidateDirs?: string[];
  /** 显式指定的静态文件服务根目录 */
  publicDir?: string;
  /** 获取服务运行时间函数（支持测试时注入固定时间） */
  uptime?: () => number;
  /** 已接入的大厅能力；不配置时兼容旧服务。 */
  lobby?: boolean;
}

/**
 * 静态资源 MIME 类型映射字典
 * 确保浏览器正确识别 HTML、JS 脚本（特别是 ES Module .mjs）、CSS 样式表与图标图片
 */
export const MIME: Record<string, string> = {
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

/**
 * 候选静态资源目录解析器
 * 在 Monorepo 环境中，无论是 `npm run dev`（运行在 tsx 源码环境）
 * 还是 `npm start`（运行在 dist 打包产物环境），均能精准向上查找到前端打包产物 packages/web/dist
 */
export function getCandidateDirs(baseDir: string = __dirname): string[] {
  return [
    path.resolve(baseDir, '../../../packages/web/dist'),
    path.resolve(process.cwd(), 'packages/web/dist'),
    path.resolve(process.cwd(), 'dist'),
    path.resolve(process.cwd(), 'public'),
  ];
}

/**
 * ============================================================================
 * 创建 HTTP 静态托管与运维探针请求处理器 (createHttpHandler)
 * ============================================================================
 * 职责：
 * 1. 静态前端资源托管与 MIME Content-Type 自动补全
 * 2. 具备企业级安全防护（防止目录遍历渗透、防止畸形 URI 崩溃）
 * 3. 运维健康检查接口 `/healthz`
 * 4. 单页应用 SPA 路由兜底回退机制
 */
export function createHttpHandler(options: HttpHandlerOptions): http.RequestListener {
  const candidateDirs = options.candidateDirs || getCandidateDirs();
  let publicDir =
    options.publicDir ||
    candidateDirs.find((d) => fs.existsSync(d)) ||
    candidateDirs[candidateDirs.length - 1]!;
  const getUptime = options.uptime || (() => Math.round(process.uptime()));

  return (req, res) => {
    let pathname: string;
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      pathname = decodeURIComponent(url.pathname);
      // fs.readFile 对空字节路径会同步抛错，必须在进入文件系统前拒绝。
      if (pathname.includes('\0')) throw new Error('Invalid path');
    } catch {
      // 安全防护 P0：恶意畸形 URI 编码（如 /% 或 /%zz）返回 400，防止未捕获异常导致 Node.js 进程崩溃
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (pathname === '/config') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ capabilities: { lobby: options.lobby === true, invites: options.lobby === true },
        lobby: { inviteTimeoutSec: 30, matchTimeoutSec: 60 },
        iceServers: [{ urls: ['stun:stun.qq.com:3478', 'stun:stun.aliyun.com:3478'] },
          { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }] }));
      return;
    }

    // 1. Kubernetes / 云原生健康检查探针 (/healthz)
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rooms: options.registry.roomCount, uptime: getUptime() }));
      return;
    }

    // 动态探测有效的静态资源目录
    if (!options.publicDir) {
      for (const d of candidateDirs) {
        if (fs.existsSync(d)) {
          publicDir = d;
          break;
        }
      }
    }

    // 根路由默认映射至 /index.html
    const rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.normalize(path.join(publicDir, rel));

    // 安全防护 P2：目录穿越攻击防范 (Path Traversal Protection)
    // 利用 path.relative 计算请求路径相对 publicDir 的相对偏移，杜绝诸如 ../../etc/passwd 或前缀混淆
    const relToPublic = path.relative(publicDir, filePath);
    const isOutside = relToPublic.startsWith('..') || path.isAbsolute(relToPublic);

    if (isOutside) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    // 2. 静态文件读取与传输
    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA 单页应用支持：若请求路径未带文件后缀名且文件不存在，回退渲染 index.html
        if (!path.extname(rel)) {
          const indexPath = path.join(publicDir, 'index.html');
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

      // 文件存在，根据扩展名输出正确的 MIME 与缓存头
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  };
}
