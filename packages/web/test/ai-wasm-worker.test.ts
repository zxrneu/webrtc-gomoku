import { describe, expect, it, vi } from 'vitest';
import { applyMove, create, currentColor } from '@webrtc-gomoku/core';
import { createSearchWorkerHandler } from '../src/ai/workerRuntime';
import { runSearchSharded } from '../src/ai/searchDriver';
import { isWorkerRequest, isWorkerResponse } from '../src/ai/workerProtocol';
import { withBackendPreference } from '../src/ai/backendOptions';
import { createWorkerSearchDriver } from '../src/ai/workerClient';

function position() {
  const game = create();
  for (const [x, y] of [[7, 7], [8, 7], [6, 6], [9, 8], [6, 8], [7, 9]]) applyMove(game, x!, y!, currentColor(game));
  return game;
}
function drain(queue: (() => void)[]): void {
  for (let i = 0; queue.length && i < 1000; i += 1) queue.shift()?.();
  expect(queue).toHaveLength(0);
}

describe('网页 Worker 的 Rust/WASM 接入', () => {
  it.each([undefined, 'ts'] as const)('backend=%s 的真实搜索报告实际评分后端', (backend) => {
    const queue: (() => void)[] = [];
    const send = vi.fn();
    const handler = createSearchWorkerHandler(send, { now: () => 0, schedule: (cb) => queue.push(cb) });
    handler({ t: 'search', id: 1, game: position(), color: 1,
      options: { backend, maxDepth: 2, maxNodes: 200, vcfMaxNodes: 0, pnsMaxNodes: 0 } });
    expect(send).not.toHaveBeenCalled();
    drain(queue);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ stats: expect.objectContaining({
      backend: backend ?? 'rust-wasm',
    }) }));
  });

  it('调度器调用注入的会话工厂并保留取消语义', () => {
    const queue: (() => void)[] = [];
    const session = { difficulty: 'hard' as const, step: vi.fn(() => false), abort: vi.fn(),
      result: () => [7, 7] as const, stats: () => ({ depth: 0, nodes: 0, elapsedMs: 0, cutoff: 'depth' as const, bestScore: 0, fromOpening: true }) };
    const createSession = vi.fn(() => session);
    const done = vi.fn();
    const cancel = runSearchSharded(create(), 1, {}, { createSession, now: () => 0, schedule: (cb) => queue.push(cb) }, done);
    expect(createSession).toHaveBeenCalledTimes(1);
    cancel(); drain(queue);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });

  it('消息边界拒绝未知后端名称', () => {
    const request = { t: 'search', id: 1, game: create(), color: 1 };
    expect(isWorkerRequest({ ...request, options: { backend: 'rust-wasm' } })).toBe(true);
    expect(isWorkerRequest({ ...request, options: { backend: 'gpu' } })).toBe(false);
    const stats = { depth: 0, nodes: 0, elapsedMs: 0, cutoff: 'depth', bestScore: 0, fromOpening: true };
    expect(isWorkerResponse({ t: 'result', id: 1, move: [7, 7], stats: { ...stats, backend: 'gpu' } })).toBe(false);
  });

  it('调用方注入会话工厂时由本地调度器执行，不丢弃注入配置', () => {
    const worker = vi.fn(() => null);
    const fallback = vi.fn(() => () => undefined);
    const createSession = vi.fn();
    createWorkerSearchDriver(worker, fallback)(create(), 1, {}, { createSession }, vi.fn());
    expect(worker).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('地址参数提供 TS 对照，显式调用参数优先，未知值使用默认 WASM', () => {
    expect(withBackendPreference({}, '')).toEqual({ backend: 'rust-wasm' });
    expect(withBackendPreference({}, '?aiEngine=ts')).toEqual({ backend: 'ts' });
    expect(withBackendPreference({}, '?aiEngine=gpu')).toEqual({ backend: 'rust-wasm' });
    expect(withBackendPreference({ backend: 'ts' }, '?aiEngine=rust-wasm')).toEqual({ backend: 'ts' });
  });
});
