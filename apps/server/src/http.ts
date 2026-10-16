import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export interface HttpHandlerOptions {
  registry: { readonly roomCount: number };
  candidateDirs?: string[];
  publicDir?: string;
  uptime?: () => number;
}

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
 * 候选静态资源目录列表：基准路径支持注入便于测试
 * 默认向上 3 级（apps/server/src 或 apps/server/dist -> 根目录）解析 packages/web/dist
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
 * 创建 HTTP 请求处理器
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
    } catch {
      // P0: 畸形 URI 编码（如 /% 或 /%zz）返回 400，防止 uncaughtException 导致进程崩溃
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rooms: options.registry.roomCount, uptime: getUptime() }));
      return;
    }

    if (!options.publicDir) {
      for (const d of candidateDirs) {
        if (fs.existsSync(d)) {
          publicDir = d;
          break;
        }
      }
    }

    const rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.normalize(path.join(publicDir, rel));

    // P2: 使用 path.relative 防范越界遍历与兄弟目录前缀混淆（如 /srv/dist vs /srv/dist2）
    const relToPublic = path.relative(publicDir, filePath);
    const isOutside = relToPublic.startsWith('..') || path.isAbsolute(relToPublic);

    if (isOutside) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
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
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  };
}
