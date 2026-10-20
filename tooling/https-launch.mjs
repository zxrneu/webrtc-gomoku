/** 为两种服务注入相同证书，保留各自的地址配置约定。 */
export function httpsLaunchPlan(target, env) {
  if (target !== 'node' && target !== 'rust') throw new Error(`不支持的服务：${target}`);
  const cert = env.TLS_CERT_FILE?.trim();
  const key = env.TLS_KEY_FILE?.trim();
  if (!!cert !== !!key) throw new Error('必须同时配置 TLS_CERT_FILE 和 TLS_KEY_FILE');
  const tls = { TLS_CERT_FILE: cert || '.certs/lan-cert.pem', TLS_KEY_FILE: key || '.certs/lan-key.pem' };
  return target === 'rust' ? {
    command: 'cargo', args: ['run', '--manifest-path', 'apps/signaling-rust/Cargo.toml'],
    env: { ...tls, GOMOKU_HOST: env.GOMOKU_HOST || '0.0.0.0', GOMOKU_PORT: env.GOMOKU_PORT || '3443',
      GOMOKU_PUBLIC_DIR: env.GOMOKU_PUBLIC_DIR || 'packages/web/dist' },
  } : {
    command: 'node', args: ['apps/server/dist/server.js'],
    env: { ...tls, HOST: env.HOST || '0.0.0.0', PORT: env.PORT || '3443' },
  };
}
