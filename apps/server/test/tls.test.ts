import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTransportServer } from '../src/tls';
import { loadTlsOptions } from '../../../tooling/tls.mjs';

const base = path.resolve('fixture-root');
const cert = Buffer.from('certificate');
const key = Buffer.from('private-key');

describe('TLS 启动配置', () => {
  it('未配置证书时保留 HTTP 且不读取文件', () => {
    const read = vi.fn();
    expect(loadTlsOptions({}, base, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([{ TLS_CERT_FILE: 'cert.pem' }, { TLS_KEY_FILE: 'key.pem' }])('拒绝单独配置证书或私钥', env => {
    const read = vi.fn();
    expect(() => loadTlsOptions(env, base, read)).toThrow(/TLS_CERT_FILE.*TLS_KEY_FILE/);
    expect(read).not.toHaveBeenCalled();
  });
  it('证书相对路径始终相对传入的仓库根解析', () => {
    const read = vi.fn((file: string) => file.endsWith('cert.pem') ? cert : key);
    expect(loadTlsOptions({ TLS_CERT_FILE: '.certs/cert.pem', TLS_KEY_FILE: '.certs/key.pem' }, base, read))
      .toEqual({ cert, key, minVersion: 'TLSv1.2' });
    expect(read.mock.calls).toEqual([[path.join(base, '.certs/cert.pem')], [path.join(base, '.certs/key.pem')]]);
  });
  it('允许运维通过环境变量传入外部证书的绝对路径', () => {
    const certPath = path.resolve('external', 'cert.pem');
    const keyPath = path.resolve('external', 'key.pem');
    const read = vi.fn((file: string) => file === certPath ? cert : key);
    loadTlsOptions({ TLS_CERT_FILE: certPath, TLS_KEY_FILE: keyPath }, base, read);
    expect(read.mock.calls).toEqual([[certPath], [keyPath]]);
  });
  it('证书读取失败时中止启动并指出配置项', () => {
    const read = vi.fn(() => { throw new Error('unreadable'); });
    expect(() => loadTlsOptions({ TLS_CERT_FILE: 'missing.pem', TLS_KEY_FILE: 'key.pem' }, base, read))
      .toThrow(/TLS_CERT_FILE/);
  });
  it('私钥读取失败时中止启动并指出配置项', () => {
    const read = vi.fn((file: string) => { if (file.endsWith('key.pem')) throw new Error('unreadable'); return cert; });
    expect(() => loadTlsOptions({ TLS_CERT_FILE: 'cert.pem', TLS_KEY_FILE: 'key.pem' }, base, read))
      .toThrow(/TLS_KEY_FILE/);
  });
  it('默认工厂产生 HTTP 服务器且不监听端口', () => {
    const server = createTransportServer((_req, res) => res.end('ok'));
    expect(server).toBeInstanceOf(http.Server);
    expect(server.listening).toBe(false);
  });
  it('TLS 工厂将证书传给 HTTPS 服务器', () => {
    const server = new http.Server();
    const create = vi.spyOn(https, 'createServer').mockReturnValue(server as unknown as https.Server);
    const handler: http.RequestListener = (_req, res) => res.end('ok');
    const options = { cert, key, minVersion: 'TLSv1.2' as const };
    expect(createTransportServer(handler, options)).toBe(server);
    expect(create).toHaveBeenCalledWith(options, handler);
    create.mockRestore();
  });
});
