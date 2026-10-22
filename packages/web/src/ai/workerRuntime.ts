/** Worker 的消息编排；调度和时钟可注入，无浏览器依赖的单测。 */
import { createWasmSearchSession, currentColor, loadWinningStrategy, MATE_SCORE, type WinningStrategy } from '@webrtc-gomoku/core';
import type { DriverOptions } from './searchDriver';
import { runSearchSharded } from './searchDriver';
import { isWorkerRequest, type WorkerResponse } from './workerProtocol';

/** Worker 内默认分片时长（毫秒）：独立线程无 UI 阻塞，250ms 可消除频繁 setTimeout 宏任务空转（PRD P0-3） */
export const DEFAULT_WORKER_SLICE_MS = 250;

export function createSearchWorkerHandler(
  send: (reply: WorkerResponse) => void,
  driver: DriverOptions = {},
): (data: unknown) => void {
  let currentId = 0;
  let strategy: WinningStrategy | null = null;
  let cancel: (() => void) | null = null;
  return (data) => {
    if (!isWorkerRequest(data)) return;
    if (data.t === 'cancel') {
      if (data.id === currentId) { cancel?.(); cancel = null; }
      return;
    }
    cancel?.();
    currentId = data.id;
    const proof = data.color === currentColor(data.game) ? strategy?.proofFor(data.game) : null;
    if (proof) {
      let cancelled = false;
      cancel = () => { cancelled = true; };
      const schedule = driver.schedule ?? ((cb: () => void): void => { setTimeout(cb, 0); });
      schedule(() => {
        if (cancelled || currentId !== data.id) return;
        cancel = null;
        send({ t: 'result', id: data.id, move: [proof.at % 15, Math.floor(proof.at / 15)], stats: {
          depth: 0, nodes: 0, elapsedMs: 0, cutoff: 'depth', bestScore: MATE_SCORE - 1,
          fromOpening: false, proofStatus: 'win', winningProof: proof,
          backend: 'ts',
        } });
      });
      return;
    }
    const effectiveDriver: DriverOptions = {
      createSession: createWasmSearchSession,
      sliceMs: driver.sliceMs ?? DEFAULT_WORKER_SLICE_MS,
      ...driver,
    };
    cancel = runSearchSharded(data.game, data.color, data.options, effectiveDriver, (move, stats) => {
      cancel = null;
      if (stats.proofStatus === 'win') strategy = loadWinningStrategy({
        format: 'gomoku-proof-v1', rules: 'freestyle-15', game: data.game,
        attacker: data.color, proof: stats.winningProof,
      });
      send({ t: 'result', id: data.id, move, stats });
    });
  };
}
