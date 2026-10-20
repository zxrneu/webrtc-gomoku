import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, symlinkSync, readlinkSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const templates = fileURLToPath(new URL('../../deploy/production/', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Fake only OS/network boundaries. Real Bash, files, symlinks and pipe failure handling run locally.
const commandStub = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const name = path.basename(process.argv[1]), args = process.argv.slice(2), env = process.env;
fs.appendFileSync(env.TEST_LOG, JSON.stringify({ name, args, proxy: env.HTTPS_PROXY }) + '\\n');
const value = flag => args[args.indexOf(flag) + 1];
if (name === 'flock') process.exit(env.TEST_LOCK_BUSY === '1' ? 1 : 0);
if (name === 'lego') process.exit(0);
if (name === 'systemctl') {
  if (args.includes('--property=WorkingDirectory')) process.stdout.write(env.TEST_APP + '\\n');
  else if (args.includes('--property=User')) process.stdout.write('fixture-user\\n');
  else if (args[0] === 'restart' && env.TEST_RESTART_FAIL === '1') {
    const calls = fs.readFileSync(env.TEST_LOG, 'utf8').trim().split('\\n').map(JSON.parse);
    if (calls.filter(c => c.name === name && c.args[0] === 'restart').length === 1) process.exit(1);
  }
  process.exit(0);
}
if (name === 'id') { process.stdout.write('fixture-group\\n'); process.exit(0); }
if (name === 'curl') process.exit(env.TEST_HEALTH_FAIL === '1' ? 1 : 0);
if (name === 'openssl') {
  if (args.includes('-checkip')) process.exit(env.TEST_INVALID_IP === '1' ? 1 : 0);
  if (args.includes('-checkend')) process.exit(env.TEST_EXPIRED === '1' ? 1 : 0);
  if (args.includes('-pubin')) process.stdout.write(fs.readFileSync(0));
  else if (args.includes('-pubout')) process.stdout.write(env.TEST_KEY_MISMATCH === '1' ? 'wrong-key' : 'public-key');
  else if (args.includes('-pubkey')) process.stdout.write('public-key');
  else if (args.includes('-outform')) process.stdout.write(fs.readFileSync(value('-in')));
  process.exit(0);
}
if (name === 'sha256sum') {
  process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(0)).digest('hex') + '  -\\n');
  process.exit(0);
}
if (name === 'install') {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (['-m', '-o', '-g'].includes(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  if (args.includes('-d')) for (const dir of positional) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  else { fs.copyFileSync(positional[0], positional[1]); fs.chmodSync(positional[1], parseInt(value('-m'), 8)); }
  process.exit(0);
}
if (name === 'mv') { fs.renameSync(args.at(-2), args.at(-1)); process.exit(0); }
throw new Error('Unexpected fixture command: ' + name);
`;

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gomoku-production-')));
  roots.push(root);
  const base = path.join(root, 'acme with spaces'), app = path.join(root, 'app'), bin = path.join(root, 'bin');
  for (const dir of [base, app, bin]) mkdirSync(dir, { recursive: true });
  const log = path.join(root, 'commands.jsonl');
  writeFileSync(log, '');
  writeFileSync(path.join(base, 'ip'), '198.51.100.10\n');
  for (const name of ['renew', 'install-certificate']) copyFileSync(path.join(templates, name + '.example'), path.join(base, name));
  for (const name of ['flock', 'systemctl', 'id', 'curl', 'openssl', 'sha256sum', 'install', 'mv']) {
    writeFileSync(path.join(bin, name), commandStub); chmodSync(path.join(bin, name), 0o700);
  }
  writeFileSync(path.join(base, 'lego'), commandStub); chmodSync(path.join(base, 'lego'), 0o700);
  const certs = path.join(base, 'production', 'certificates');
  mkdirSync(certs, { recursive: true });
  writeFileSync(path.join(certs, '198.51.100.10.crt'), 'fixture-certificate');
  writeFileSync(path.join(certs, '198.51.100.10.key'), 'fixture-key');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_APP: app, TEST_LOG: log };
  const run = (script, overrides = {}, args = []) => spawnSync('bash', [path.join(base, script), ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000,
  });
  const calls = name => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(c => c.name === name);
  return { base, app, run, calls };
}

describe('production certificate templates (fake IO, no root or network)', () => {
  it('renews the configured IP with the short-lived profile and deployment hook', () => {
    const t = fixture();
    writeFileSync(path.join(t.base, 'acme.env'), 'GOMOKU_ACME_PROXY=http://127.0.0.1:7890\n');
    const result = t.run('renew');
    expect(result.status, result.stderr).toBe(0);
    const [call] = t.calls('lego');
    expect(call.proxy).toBe('http://127.0.0.1:7890');
    expect(call.args).toEqual(['run', '--server', 'letsencrypt', '--path', path.join(t.base, 'production'),
      '--account-id', 'gomoku-ip', '--http', '--domains', '198.51.100.10', '--profile', 'shortlived',
      '--accept-tos', '--no-random-sleep', '--deploy-hook', path.join(t.base, 'install-certificate')]);
  });
  it('skips a concurrent renewal without contacting the CA', () => {
    const t = fixture();
    expect(t.run('renew', { TEST_LOCK_BUSY: '1' }).status).toBe(0);
    expect(t.calls('lego')).toHaveLength(0);
  });
  it.each([{ TEST_INVALID_IP: '1' }, { TEST_EXPIRED: '1' }, { TEST_KEY_MISMATCH: '1' }])(
    'rejects an invalid certificate before switching or restarting: %j', overrides => {
      const t = fixture();
      expect(t.run('install-certificate', overrides).status).not.toBe(0);
      expect(existsSync(path.join(t.app, '.certs', 'current'))).toBe(false);
      expect(t.calls('systemctl').some(call => call.args[0] === 'restart')).toBe(false);
    });
  it('installs the first certificate without starting the application', () => {
    const t = fixture();
    const result = t.run('install-certificate', {}, ['--install-only']);
    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(path.join(t.app, '.certs', 'current'))).toMatch(/^releases\/[a-f0-9]{64}$/);
    expect(t.calls('systemctl').some(call => call.args[0] === 'restart')).toBe(false);
    expect(t.calls('curl')).toHaveLength(0);
  });
  it('verifies HTTPS through loopback after restarting without disabling certificate validation', () => {
    const t = fixture();
    const result = t.run('install-certificate');
    expect(result.status, result.stderr).toBe(0);
    expect(t.calls('systemctl').filter(c => c.args[0] === 'restart')).toHaveLength(1);
    const [health] = t.calls('curl');
    expect(health.args).toContain('198.51.100.10:443:127.0.0.1');
    expect(health.args).not.toContain('-k');
    expect(health.args).not.toContain('--insecure');
  });
  it('restores the previous certificate if the HTTPS health check fails', () => {
    const t = fixture(), certs = path.join(t.app, '.certs');
    mkdirSync(path.join(certs, 'releases', 'previous'), { recursive: true });
    symlinkSync('releases/previous', path.join(certs, 'current'));
    const result = t.run('install-certificate', { TEST_HEALTH_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(readlinkSync(path.join(certs, 'current'))).toBe('releases/previous');
    expect(t.calls('systemctl').filter(c => c.args[0] === 'restart')).toHaveLength(2);
  });
  it('restores the previous certificate if the first service restart fails', () => {
    const t = fixture(), certs = path.join(t.app, '.certs');
    mkdirSync(path.join(certs, 'releases', 'previous'), { recursive: true });
    symlinkSync('releases/previous', path.join(certs, 'current'));
    expect(t.run('install-certificate', { TEST_RESTART_FAIL: '1' }).status).not.toBe(0);
    expect(readlinkSync(path.join(certs, 'current'))).toBe('releases/previous');
    expect(t.calls('curl')).toHaveLength(0);
    expect(t.calls('systemctl').filter(c => c.args[0] === 'restart')).toHaveLength(2);
  });
});
