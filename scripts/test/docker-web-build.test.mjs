import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const { buildSync } = createRequire(new URL('../../packages/web/node_modules/vite/package.json', import.meta.url))('esbuild');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('Docker 前端阶段复制的文件可独立加载生产 Vite 配置', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gomoku-docker-web-'));
  roots.push(root);
  const dockerfile = readFileSync(path.join(repo, 'apps/signaling-rust/Dockerfile'), 'utf8');
  const stage = dockerfile.split(/FROM [^\n]+ AS webbuilder\n/)[1]?.split(/^FROM /m)[0];
  expect(stage).toBeDefined();
  for (const line of stage.split('\n')) {
    if (!line.startsWith('COPY ')) continue;
    const args = line.slice(5).trim().split(/\s+/);
    const destination = args.pop();
    for (const source of args) cpSync(path.join(repo, source), path.join(root, destination, destination === './' ? source : ''), {
      recursive: true,
      filter: entry => !['node_modules', 'dist', 'dist-standalone', 'target'].some(part => entry.split(path.sep).includes(part)),
    });
  }

  // 使用 Vite 同款打包器解析本地依赖；npm 包视作已安装，测试不联网、不启动 Docker。
  expect(() => buildSync({
    absWorkingDir: root, entryPoints: ['packages/web/vite.config.ts'], bundle: true,
    platform: 'node', format: 'esm', packages: 'external', write: false, logLevel: 'silent',
  })).not.toThrow();
});
