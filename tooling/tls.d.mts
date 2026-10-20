import type { ServerOptions } from 'node:https';

export function loadTlsOptions(
  env: NodeJS.ProcessEnv,
  rootDir: string,
  readFile?: (file: string) => Buffer,
): ServerOptions | undefined;
