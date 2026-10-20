#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { configureHttps, parseSetupArgs } from '../tooling/https-setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = message => process.stdout.write(`${message}\n`);

async function download(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new Error(`mkcert 下载失败：HTTP ${response.status}；${url}`);
  let size = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    callback(size > 20 * 1024 * 1024 ? new Error('mkcert 下载内容超过 20 MB') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(file, { mode: 0o700, flags: 'wx' }));
}

function run(file, args, options) {
  const result = spawnSync(file, args, { cwd: options.root, env: { ...process.env, CAROOT: options.caRoot },
    encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', shell: false });
  if (result.error) throw new Error(`mkcert 执行失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`mkcert ${args[0]} 失败（${result.status ?? result.signal}），请检查上方提示；Linux/Firefox 可能需要 certutil，Windows 可能需要管理员终端`);
  return result.stdout ?? '';
}

try {
  const options = parseSetupArgs(process.argv.slice(2));
  if (options.help) {
    log('用法：pnpm https:setup [--ip 局域网IP] [--host 主机名] [--no-trust]\n--ip/--host 可重复；默认自动探测局域网 IPv4 并安装本机 CA。\n--no-trust 仅生成证书，不安装系统信任。二进制和证书存放于 .certs/。');
  } else {
    const result = await configureHttps({ root, options, platform: process.platform, arch: process.arch, interfaces: os.networkInterfaces() }, {
      files: { mkdir: directory => fs.mkdirSync(directory, { recursive: true, mode: 0o700 }), chmod: fs.chmodSync,
        exists: fs.existsSync, rename: fs.renameSync, remove: file => fs.rmSync(file, { force: true }), copy: fs.copyFileSync },
      download, run, log,
    });
    log(`\n证书已生成：.certs/lan-cert.pem、.certs/lan-key.pem\n证书地址：${result.hosts.join(', ')}\n手机只需导入：.certs/rootCA.pem；不要分享任何私钥。`);
    if (!options.trust) log('本次未安装本机信任；正常浏览器使用前请重新运行 pnpm https:setup。');
    if (result.hosts.length === 3) log('未检测到局域网 IP，可运行 pnpm https:setup --ip 实际局域网IP。');
    log('启动 Node：pnpm build && pnpm start:https\n启动 Rust：pnpm build:web && pnpm start:https:rust\n访问：https://证书中的局域网IP:3443/lobby（IPv6 地址需加方括号）');
  }
} catch (error) {
  process.stderr.write(`HTTPS 配置失败：${error.message}\n`);
  process.exitCode = 1;
}
