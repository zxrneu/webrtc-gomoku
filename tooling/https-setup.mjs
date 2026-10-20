import path from 'node:path';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const VERSION = 'v1.4.4';
const BASE_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** 固定官方发布版本，避免重跑时悄悄换用不同版本的可执行文件。 */
export function mkcertAsset(platform, arch) {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[arch];
  if (!os || !cpu || (cpu === 'arm' && os !== 'linux')) throw new Error(`不支持的 mkcert 平台：${platform}/${arch}`);
  const name = `mkcert-${VERSION}-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`;
  return { name, url: `https://github.com/FiloSottile/mkcert/releases/download/${VERSION}/${name}` };
}

function validHost(value) {
  const ascii = domainToASCII(value);
  const labels = ascii.split('.');
  if (!ascii || ascii.length > 253 || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error(`无效主机名：${value}；请提供不含协议、端口或路径的主机名`);
  }
  return ascii;
}

export function parseSetupArgs(args) {
  const result = { ips: [], hosts: [], trust: true, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--no-trust') { result.trust = false; continue; }
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (arg !== '--ip' && arg !== '--host') throw new Error(`未知参数：${arg}；运行 --help 查看用法`);
    const value = args[++index]?.trim();
    if (!value || value.startsWith('-')) throw new Error(`${arg} 缺少参数`);
    if (arg === '--host') result.hosts.push(validHost(value));
    else {
      if (!isIP(value) || value.includes('%')) throw new Error(`无效 IP：${value}`);
      result.ips.push(value);
    }
  }
  return result;
}

function isPrivateIpv4(address) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** 默认仅探测常见内网 IPv4；自定义网段/IPv6 由 --ip 显式指定。 */
export function certificateHosts(options, interfaces) {
  const detected = Object.entries(interfaces).flatMap(([name, entries]) => {
    if (/^(utun|tun|tap|wg|docker|veth|br-|tailscale)|vpn|wireguard/i.test(name)) return [];
    return (entries ?? []).filter(entry => !entry.internal && isPrivateIpv4(entry.address)).map(entry => entry.address);
  });
  return [...new Set([...BASE_HOSTS, ...(options.ips.length ? options.ips : detected), ...options.hosts])];
}

async function ensureBinary(input, ports) {
  const asset = mkcertAsset(input.platform, input.arch);
  const binary = path.join(input.root, '.certs', 'bin', asset.name);
  const temp = `${binary}.download${input.platform === 'win32' ? '.exe' : ''}`;
  const execution = { root: input.root, caRoot: path.join(input.root, '.certs', 'ca'), capture: true };
  const check = file => {
    if (ports.run(file, ['-version'], execution).trim() !== VERSION) throw new Error('mkcert 版本校验失败，请删除 .certs/bin 中的对应文件后重试');
  };
  if (ports.files.exists(binary)) { check(binary); return binary; }
  ports.log(`下载官方 mkcert ${VERSION}：${asset.url}`);
  try {
    await ports.download(asset.url, temp);
    if (input.platform !== 'win32') ports.files.chmod(temp, 0o700);
    check(temp);
    ports.files.rename(temp, binary);
    return binary;
  } finally { ports.files.remove(temp); }
}

/** 注入文件、下载和命令端口，单测不访问网络或系统信任库。 */
export async function configureHttps(input, ports) {
  mkcertAsset(input.platform, input.arch);
  const certDir = path.join(input.root, '.certs');
  const caRoot = path.join(certDir, 'ca');
  for (const directory of [certDir, path.join(certDir, 'bin'), caRoot]) {
    ports.files.mkdir(directory);
    if (input.platform !== 'win32') ports.files.chmod(directory, 0o700);
  }
  const binary = await ensureBinary(input, ports);
  const execution = { root: input.root, caRoot, capture: false };
  if (input.options.trust) {
    ports.log('安装本项目 CA 到本机信任库；系统可能要求管理员授权。');
    ports.run(binary, ['-install'], execution);
  }
  const hosts = certificateHosts(input.options, input.interfaces);
  const certFile = path.join(certDir, 'lan-cert.pem');
  const keyFile = path.join(certDir, 'lan-key.pem');
  ports.run(binary, ['-cert-file', certFile, '-key-file', keyFile, ...hosts], execution);
  if (input.platform !== 'win32') {
    ports.files.chmod(keyFile, 0o600);
    ports.files.chmod(path.join(caRoot, 'rootCA-key.pem'), 0o600);
  }
  ports.files.copy(path.join(caRoot, 'rootCA.pem'), path.join(certDir, 'rootCA.pem'));
  return { hosts, certFile, keyFile };
}
