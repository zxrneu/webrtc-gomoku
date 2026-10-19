import { describe, expect, it, vi } from 'vitest';
import { BLACK, WHITE, create, applyMove, currentColor, verifyWinningProof } from '@webrtc-gomoku/core';
import type { AiSearchStats } from '@webrtc-gomoku/core';
import { createWorkerSearchDriver, type SearchWorker } from '../src/ai/workerClient';
import { createSearchWorkerHandler, DEFAULT_WORKER_SLICE_MS } from '../src/ai/workerRuntime';
import { isWorkerRequest, isWorkerResponse, type WorkerRequest } from '../src/ai/workerProtocol';

const stats: AiSearchStats = { depth: 0, nodes: 0, elapsedMs: 0, cutoff: 'depth', bestScore: 0, fromOpening: true };
class FakeWorker implements SearchWorker {
  readonly requests: WorkerRequest[] = [];
  receive: (data: unknown) => void = () => undefined;
  fail: () => void = () => undefined;
  readonly terminate = vi.fn();
  send(request: WorkerRequest): void { this.requests.push(request); }
  listen(receive: (data: unknown) => void, fail: () => void): () => void {
    this.receive = receive;
    this.fail = fail;
    return () => { this.receive = () => undefined; };
  }
}

describe('Worker 搜索驱动', () => {
  it('搜索只发送消息、不在主线程执行，并复用 Worker', () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const fallback = vi.fn(() => () => undefined);
    const run = createWorkerSearchDriver(factory, fallback);
    const done = vi.fn();
    run(create(), BLACK, {}, {}, done);
    expect(fallback).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    worker.receive({ t: 'result', id: 1, move: [7, 7], stats });
    expect(done).toHaveBeenCalledExactlyOnceWith([7, 7], stats);
    run(create(), BLACK, {}, {}, done)();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('取消后和新局开始后都忽略旧搜索的结果', () => {
    const worker = new FakeWorker();
    const run = createWorkerSearchDriver(() => worker);
    const old = vi.fn();
    const done = vi.fn();
    const cancel = run(create(), BLACK, {}, {}, old);
    cancel();
    cancel();
    run(create(), BLACK, {}, {}, done);
    worker.receive({ t: 'result', id: 1, move: [7, 7], stats });
    expect(old).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    worker.receive({ t: 'result', id: 2, move: [7, 7], stats });
    expect(done).toHaveBeenCalledTimes(1);
    expect(worker.requests.filter((r) => r.t === 'cancel')).toHaveLength(1);
  });

  it.each(['unavailable', 'startup', 'runtime', 'message', 'invalid-move'])('%s 时回退分片搜索', (failure) => {
    const worker = new FakeWorker();
    const fallback = vi.fn(() => () => undefined);
    const run = createWorkerSearchDriver(() => {
      if (failure === 'unavailable') return null;
      if (failure === 'startup') throw new Error('blocked');
      return worker;
    }, fallback);
    const done = vi.fn();
    run(create(), BLACK, {}, {}, done);
    if (failure === 'runtime') worker.fail();
    if (failure === 'message') worker.receive({ nonsense: true });
    if (failure === 'invalid-move') worker.receive({ t: 'result', id: 1, move: [99, 7], stats });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });

  it('回退搜索同样可以取消', () => {
    const abort = vi.fn();
    const run = createWorkerSearchDriver(() => null, () => abort);
    const cancel = run(create(), BLACK, {}, {}, vi.fn());
    cancel();
    cancel();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('重复错误事件只启动一次回退搜索', () => {
    const worker = new FakeWorker();
    const fallback = vi.fn(() => () => undefined);
    createWorkerSearchDriver(() => worker, fallback)(create(), BLACK, {}, {}, vi.fn());
    worker.fail();
    worker.fail();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('Worker 消息边界', () => {
  it('接受合法请求，拒绝畸形棋盘和非数值参数', () => {
    const request = { t: 'search', id: 1, game: create(), color: BLACK, options: { difficulty: 'hard' } };
    expect(isWorkerRequest(request)).toBe(true);
    expect(isWorkerRequest({ ...request, game: { ...create(), board: [] } })).toBe(false);
    expect(isWorkerRequest({ ...request, options: { maxNodes: NaN } })).toBe(false);
    expect(isWorkerRequest({ ...request, options: { now: () => 1 } })).toBe(false);
    expect(isWorkerRequest({ t: 'cancel', id: 1 })).toBe(true);
  });

  it.each(['vcfMaxNodes', 'pnsMaxNodes', 'pnsTimeBudgetMs'])('深度提示参数 %s 也必须经过数值边界校验', (key) => {
    const request = { t: 'search', id: 1, game: create(), color: BLACK };
    expect(isWorkerRequest({ ...request, options: { [key]: 1000 } })).toBe(true);
    for (const invalid of [NaN, Infinity, -1, '1000', null]) {
      expect(isWorkerRequest({ ...request, options: { [key]: invalid } })).toBe(false);
    }
  });

  it('拒绝畸形坐标、统计和未知回复', () => {
    expect(isWorkerResponse({ t: 'result', id: 1, move: [7, 7], stats })).toBe(true);
    expect(isWorkerResponse({ t: 'result', id: 1, move: [7.5, 7], stats })).toBe(false);
    expect(isWorkerResponse({ t: 'result', id: 1, move: null, stats: { ...stats, nodes: NaN } })).toBe(false);
    expect(isWorkerResponse(null)).toBe(false);
  });
});

describe('Worker 内的真实搜索', () => {
  it('先调度后计算，完成后带请求 ID 回复', () => {
    const queue: (() => void)[] = [];
    const send = vi.fn();
    const receive = createSearchWorkerHandler(send, { now: () => 0, schedule: (cb) => queue.push(cb) });
    receive({ t: 'search', id: 3, game: create(), color: BLACK, options: {} });
    expect(send).not.toHaveBeenCalled();
    queue.shift()?.();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ t: 'result', id: 3, move: [7, 7] }));
  });

  it('取消或替换搜索后不发出过期结果，非法消息安全忽略', () => {
    const queue: (() => void)[] = [];
    const send = vi.fn();
    const receive = createSearchWorkerHandler(send, { now: () => 0, schedule: (cb) => queue.push(cb) });
    receive(null);
    receive({ t: 'search', id: 1, game: create(), color: BLACK, options: {} });
    receive({ t: 'cancel', id: 99 });
    receive({ t: 'search', id: 2, game: create(), color: BLACK, options: {} });
    receive({ t: 'cancel', id: 2 });
    while (queue.length) queue.shift()?.();
    expect(send).not.toHaveBeenCalled();
  });

  it('默认采用 DEFAULT_WORKER_SLICE_MS（250ms）分片，避免频繁 setTimeout 空转（PRD P0-3）', () => {
    expect(DEFAULT_WORKER_SLICE_MS).toBe(250);
  });
});

it('Worker 保存已验证的策略，下一回合沿证书执行而不重搜', () => {
  const queue: (() => void)[] = [];
  const send = vi.fn();
  const receive = createSearchWorkerHandler(send, { now: () => 0, schedule: (cb) => queue.push(cb) });
  const game = create();
  for (const [x, y] of [[4, 7], [0, 0], [5, 7], [0, 2], [6, 7], [14, 14]]) {
    applyMove(game, x, y, currentColor(game));
  }
  receive({ t: 'search', id: 1, game, color: BLACK, options: { difficulty: 'hard' } });
  while (queue.length) queue.shift()?.();
  const first = send.mock.calls[0]?.[0];
  expect(first?.stats.proofStatus).toBe('win');
  receive({ t: 'search', id: 9, game, color: WHITE, options: {} });
  while (queue.length) queue.shift()?.();
  expect(send.mock.calls[1]?.[0]?.move).toBeNull();
  applyMove(game, first.move[0], first.move[1], BLACK);
  applyMove(game, 14, 0, WHITE);
  receive({ t: 'search', id: 2, game, color: BLACK, options: { difficulty: 'hard' } });
  while (queue.length) queue.shift()?.();
  const next = send.mock.calls[2]?.[0];
  expect(next?.stats.nodes).toBe(0);
  expect(verifyWinningProof(game, BLACK, next?.stats.winningProof)).toBe(true);
});
