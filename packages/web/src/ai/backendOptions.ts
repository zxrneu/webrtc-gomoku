import type { AiOptions } from '@webrtc-gomoku/core';

export type AiBackend = NonNullable<AiOptions['backend']>;

export function isAiBackend(value: unknown): value is AiBackend {
  return value === 'ts' || value === 'rust-wasm';
}

/** 对照实验入口；显式调用参数优先于地址中的偏好。 */
export function withBackendPreference(options: AiOptions, query: string): AiOptions {
  const selected = new URLSearchParams(query).get('aiEngine');
  return { ...options, backend: options.backend ?? (selected === 'ts' ? 'ts' : 'rust-wasm') };
}
