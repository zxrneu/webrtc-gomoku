/** 管理一个常驻搜索 Worker：请求隔离、取消、错误回退。 */
import type { AiOptions, AiSearchStats, GameState, PlayerColor, Point } from '@webrtc-gomoku/core';
import type { DriverOptions } from './searchDriver';
import { runSearchSharded } from './searchDriver';
import { isWorkerResponse, type WorkerRequest } from './workerProtocol';

export interface SearchWorker {
  send(request: WorkerRequest): void;
  listen(receive: (data: unknown) => void, fail: () => void): () => void;
  terminate(): void;
}
type SearchDriver = typeof runSearchSharded;
interface ActiveSearch {
  id: number;
  cancel(): void;
  complete(move: Point | null, stats: AiSearchStats): void;
  fallback(): void;
  isLegal(move: Point | null): boolean;
}
interface SearchInput {
  id: number;
  game: GameState;
  color: PlayerColor;
  options: AiOptions;
}

class WorkerDriver {
  private worker: SearchWorker | null = null;
  private unlisten: (() => void) | null = null;
  private active: ActiveSearch | null = null;
  private nextId = 0;
  constructor(private readonly factory: () => SearchWorker | null, private readonly fallback: SearchDriver) {}

  readonly run: SearchDriver = (game, color, options, driver, done) => {
    this.active?.cancel();
    const input = { id: ++this.nextId, game, color, options };
    const request = this.createRequest(input, driver, done);
    this.active = request;
    try {
      if (options.now || driver.now || driver.schedule || driver.createSession) request.fallback();
      else this.send(input, request);
    } catch { this.fail(); }
    return request.cancel;
  };

  private readonly fail = (): void => {
    this.unlisten?.();
    this.worker?.terminate();
    this.worker = null;
    this.unlisten = null;
    this.active?.fallback();
  };

  private readonly receive = (data: unknown): void => {
    if (!this.active) return;
    if (!isWorkerResponse(data)) { this.fail(); return; }
    if (data.id !== this.active.id) return;
    if (!this.active.isLegal(data.move)) { this.fail(); return; }
    const completed = this.active;
    this.active = null;
    completed.complete(data.move, data.stats);
  };

  private send(input: SearchInput, request: ActiveSearch): void {
    this.worker ??= this.factory();
    if (!this.worker) { request.fallback(); return; }
    this.unlisten ??= this.worker.listen(this.receive, this.fail);
    this.worker.send({ t: 'search', ...input });
  }

  private createRequest(input: SearchInput, driver: DriverOptions, done: Parameters<SearchDriver>[4]): ActiveSearch {
    const { id, game, color, options } = input;
    let cancelled = false;
    let fallbackStarted = false;
    let cancelFallback: (() => void) | null = null;
    const request: ActiveSearch = {
      id,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        cancelFallback?.();
        if (this.active !== request) return;
        this.active = null;
        try { this.worker?.send({ t: 'cancel', id }); } catch { this.fail(); }
      },
      complete: (move, stats) => {
        if (this.active === request) this.active = null;
        if (!cancelled) done(move, stats);
      },
      fallback: () => {
        if (cancelled || fallbackStarted) return;
        fallbackStarted = true;
        cancelFallback = this.fallback(game, color, options, driver, request.complete);
      },
      isLegal: (move) => move === null ? game.over : game.board[move[1]]?.[move[0]] === 0,
    };
    return request;
  }
}

export function createWorkerSearchDriver(
  factory: () => SearchWorker | null,
  fallback: SearchDriver = runSearchSharded,
): SearchDriver {
  return new WorkerDriver(factory, fallback).run;
}
