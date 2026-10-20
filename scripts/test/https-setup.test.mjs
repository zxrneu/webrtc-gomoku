import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mkcertAsset, certificateHosts, parseSetupArgs, configureHttps } from '../../tooling/https-setup.mjs';
import { httpsLaunchPlan } from '../../tooling/https-launch.mjs';

const address = (ip, extra = {}) => ({ address: ip, family: 'IPv4', internal: false, ...extra });
const interfaces = {
  en0: [address('192.168.1.21'), address('192.168.1.21'), address('10.0.0.3', { internal: true })],
  eth0: [address('172.17.2.3'), address('2001:db8::1', { family: 'IPv6' })],
  utun4: [address('10.8.0.2')],
  docker0: [address('172.18.0.1')],
  vpn: [address('198.18.0.1')],
};

describe('HTTPS 一键配置', () => {
  it.each([
    ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-amd64'],
    ['linux', 'x64', 'linux-amd64'], ['linux', 'arm64', 'linux-arm64'], ['linux', 'arm', 'linux-arm'],
    ['win32', 'x64', 'windows-amd64.exe'], ['win32', 'arm64', 'windows-arm64.exe'],
  ])('直接定位官方 %s/%s 二进制', (platform, arch, suffix) => {
    const asset = mkcertAsset(platform, arch);
    expect(asset.name).toBe(`mkcert-v1.4.4-${suffix}`);
    expect(asset.url).toBe(`https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/${asset.name}`);
  });
  it('不支持的平台在执行下载前明确失败', () => {
    expect(() => mkcertAsset('freebsd', 'x64')).toThrow(/不支持/);
    expect(() => mkcertAsset('win32', 'ia32')).toThrow(/不支持/);
  });
  it('识别参数并默认安装本机 CA', () => {
    expect(parseSetupArgs([])).toEqual({ ips: [], hosts: [], trust: true, help: false });
    expect(parseSetupArgs(['--', '--ip', '192.168.2.8', '--host', 'gomoku.local', '--no-trust']))
      .toEqual({ ips: ['192.168.2.8'], hosts: ['gomoku.local'], trust: false, help: false });
    expect(parseSetupArgs(['--help']).help).toBe(true);
  });
  it.each([['--ip'], ['--ip', 'https://host'], ['--ip', 'fe80::1%en0'], ['--host', '-bad'],
    ['--host', 'host;echo'], ['--host', 'https://host'], ['--wat']])('拒绝无效输入 %j', (...args) => {
    expect(() => parseSetupArgs(args)).toThrow();
  });
  it('检测真实内网 IPv4，过滤回环、VPN 和容器并去重', () => {
    expect(certificateHosts(parseSetupArgs([]), interfaces))
      .toEqual(['localhost', '127.0.0.1', '::1', '192.168.1.21', '172.17.2.3']);
  });
  it('手动 IP 覆盖自动探测并支持 IPv6 和额外主机名', () => {
    const options = parseSetupArgs(['--ip', '192.168.5.6', '--ip', '2001:db8::2', '--host', 'gomoku.local']);
    expect(certificateHosts(options, interfaces))
      .toEqual(['localhost', '127.0.0.1', '::1', '192.168.5.6', '2001:db8::2', 'gomoku.local']);
  });
  it('无内网接口时仍生成本机证书', () => {
    expect(certificateHosts(parseSetupArgs([]), {})).toEqual(['localhost', '127.0.0.1', '::1']);
  });
});

function fixture({ cached = false, trust = true } = {}) {
  const root = path.resolve('fixture-project');
  const files = {
    mkdir: vi.fn(), chmod: vi.fn(), exists: vi.fn(() => cached), rename: vi.fn(), remove: vi.fn(), copy: vi.fn(),
  };
  const events = [];
  const download = vi.fn(async () => { events.push('download'); });
  const run = vi.fn((_file, args) => {
    events.push(args[0]);
    return args[0] === '-version' ? 'v1.4.4\n' : '';
  });
  const ports = { files, download, run, log: vi.fn() };
  const input = { root, platform: 'darwin', arch: 'arm64', interfaces,
    options: parseSetupArgs(trust ? [] : ['--no-trust']) };
  return { root, files, events, download, run, ports, input };
}

describe('配置执行边界（假 IO，无网络/系统信任变更）', () => {
  it('下载并校验版本后安装 CA，再生成服务器证书，仅导出 CA 公有证书', async () => {
    const t = fixture();
    const result = await configureHttps(t.input, t.ports);
    expect(t.events).toEqual(['download', '-version', '-install', '-cert-file']);
    const certDir = path.join(t.root, '.certs');
    const binary = path.join(certDir, 'bin', 'mkcert-v1.4.4-darwin-arm64');
    expect(t.run.mock.calls[1]).toEqual([binary, ['-install'], { root: t.root, caRoot: path.join(certDir, 'ca'), capture: false }]);
    expect(t.run.mock.calls[2][1]).toEqual(['-cert-file', path.join(certDir, 'lan-cert.pem'), '-key-file',
      path.join(certDir, 'lan-key.pem'), 'localhost', '127.0.0.1', '::1', '192.168.1.21', '172.17.2.3']);
    expect(t.files.copy.mock.calls).toEqual([[path.join(certDir, 'ca', 'rootCA.pem'), path.join(certDir, 'rootCA.pem')]]);
    expect(t.files.chmod).toHaveBeenCalledWith(path.join(certDir, 'lan-key.pem'), 0o600);
    expect(result.hosts).toContain('192.168.1.21');
  });
  it('重复配置复用二进制与 CA 目录，不删除 CA', async () => {
    const t = fixture({ cached: true });
    await configureHttps(t.input, t.ports);
    expect(t.download).not.toHaveBeenCalled();
    expect(t.files.remove).not.toHaveBeenCalled();
    expect(t.events).toEqual(['-version', '-install', '-cert-file']);
  });
  it('--no-trust 仅签发证书，绝不运行 -install', async () => {
    const t = fixture({ trust: false });
    await configureHttps(t.input, t.ports);
    expect(t.events).not.toContain('-install');
    expect(t.events).toContain('-cert-file');
  });
  it('Windows 下载临时文件仍保留 exe 后缀以便直接执行校验', async () => {
    const t = fixture(); t.input.platform = 'win32';
    await configureHttps(t.input, t.ports);
    expect(t.download.mock.calls[0][1]).toMatch(/\.download\.exe$/);
    expect(t.run.mock.calls[0][0]).toMatch(/\.download\.exe$/);
    expect(t.files.chmod).not.toHaveBeenCalled();
  });
  it('下载失败清理半成品，不运行任何外部程序', async () => {
    const t = fixture(); t.download.mockRejectedValue(new Error('network failed'));
    await expect(configureHttps(t.input, t.ports)).rejects.toThrow(/network failed/);
    expect(t.run).not.toHaveBeenCalled();
    expect(t.files.rename).not.toHaveBeenCalled();
    expect(t.files.remove).toHaveBeenCalledWith(expect.stringMatching(/\.download$/));
  });
  it('错误版本不得安装信任或签发证书', async () => {
    const t = fixture(); t.run.mockReturnValue('unexpected version');
    await expect(configureHttps(t.input, t.ports)).rejects.toThrow(/版本/);
    expect(t.events).toEqual(['download']);
    expect(t.files.rename).not.toHaveBeenCalled();
  });
  it('CA 安装失败时不继续生成证书或输出成功', async () => {
    const t = fixture();
    t.run.mockImplementation((_file, args) => { if (args[0] === '-install') throw new Error('permission denied'); return 'v1.4.4'; });
    await expect(configureHttps(t.input, t.ports)).rejects.toThrow(/permission denied/);
    expect(t.run.mock.calls.map(call => call[1][0])).not.toContain('-cert-file');
  });
});

describe('Node/Rust HTTPS 启动配置', () => {
  it('Node 直接运行构建产物，证书与端口有默认值', () => {
    expect(httpsLaunchPlan('node', {})).toEqual({ command: 'node', args: ['apps/server/dist/server.js'], env: {
      TLS_CERT_FILE: '.certs/lan-cert.pem', TLS_KEY_FILE: '.certs/lan-key.pem', HOST: '0.0.0.0', PORT: '3443',
    } });
  });
  it('Rust 同一证书原生启动，使用 Rust 的地址变量', () => {
    expect(httpsLaunchPlan('rust', {})).toEqual({ command: 'cargo', args: ['run', '--manifest-path', 'apps/signaling-rust/Cargo.toml'], env: {
      TLS_CERT_FILE: '.certs/lan-cert.pem', TLS_KEY_FILE: '.certs/lan-key.pem', GOMOKU_HOST: '0.0.0.0', GOMOKU_PORT: '3443', GOMOKU_PUBLIC_DIR: 'packages/web/dist',
    } });
  });
  it('保留运维注入的证书与对应服务端口', () => {
    expect(httpsLaunchPlan('rust', { TLS_CERT_FILE: 'custom/cert.pem', TLS_KEY_FILE: 'custom/key.pem', GOMOKU_PORT: '4443' }).env)
      .toEqual({ TLS_CERT_FILE: 'custom/cert.pem', TLS_KEY_FILE: 'custom/key.pem', GOMOKU_HOST: '0.0.0.0', GOMOKU_PORT: '4443', GOMOKU_PUBLIC_DIR: 'packages/web/dist' });
    expect(httpsLaunchPlan('node', { HOST: '127.0.0.1', PORT: '4444' }).env.HOST).toBe('127.0.0.1');
  });
  it('拒绝单独注入证书以及未知启动目标', () => {
    expect(() => httpsLaunchPlan('node', { TLS_CERT_FILE: 'cert.pem' })).toThrow(/同时/);
    expect(() => httpsLaunchPlan('other', {})).toThrow(/不支持/);
  });
  it('Rust 可显式覆盖前端目录，同时默认使用已构建的新版页面', () => {
    expect(httpsLaunchPlan('rust', {}).env.GOMOKU_PUBLIC_DIR).toBe('packages/web/dist');
    expect(httpsLaunchPlan('rust', { GOMOKU_PUBLIC_DIR: 'custom/web' }).env.GOMOKU_PUBLIC_DIR).toBe('custom/web');
  });
});
