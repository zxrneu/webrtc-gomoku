import fs from 'node:fs';
import path from 'node:path';

/** 读取 TLS 配置；调用方显式传入仓库根，避免 pnpm --filter 改变 cwd。 */
export function loadTlsOptions(env, rootDir, readFile = fs.readFileSync) {
  const certFile = env.TLS_CERT_FILE?.trim();
  const keyFile = env.TLS_KEY_FILE?.trim();
  if (!certFile && !keyFile) return undefined;
  if (!certFile || !keyFile) throw new Error('HTTPS 需要同时配置 TLS_CERT_FILE 和 TLS_KEY_FILE');
  const read = (name, file) => {
    try { return readFile(path.resolve(rootDir, file)); }
    catch { throw new Error(`无法读取 ${name}；请检查证书路径和文件权限`); }
  };
  return { cert: read('TLS_CERT_FILE', certFile), key: read('TLS_KEY_FILE', keyFile), minVersion: 'TLSv1.2' };
}
