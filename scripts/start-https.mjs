#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { httpsLaunchPlan } from '../tooling/https-launch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const plan = httpsLaunchPlan(process.argv[2] ?? 'node', process.env);
  for (const file of [plan.env.TLS_CERT_FILE, plan.env.TLS_KEY_FILE]) {
    fs.accessSync(path.resolve(root, file), fs.constants.R_OK);
  }
  if (plan.command === 'node' && !fs.existsSync(path.join(root, plan.args[0]))) {
    throw new Error('Node 服务尚未构建，请先运行 pnpm build');
  }
  const result = spawnSync(plan.command === 'node' ? process.execPath : plan.command, plan.args,
    { cwd: root, env: { ...process.env, ...plan.env }, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
} catch (error) {
  process.stderr.write(`HTTPS 启动失败：${error.message}\n请先运行 pnpm https:setup；Rust 服务还需安装 Rust/Cargo。\n`);
  process.exitCode = 1;
}
