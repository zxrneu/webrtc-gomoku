import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMove, create, currentColor } from '../../src/index';
import type { AiOptions, AiSession, GameState } from '../../src/ai/types';
import { createSearchSession } from '../../src/ai/search';
import { createPositionState, evalFor, getHypoPointScore, placeStone, removeStone } from '../../src/ai/evaluate';
import { verifyWinningProof } from '../../src/ai/proof';
import { createKernel } from '../../src/ai/wasm/kernel';
import { createWasmSearchSession } from '../../src/ai/wasm/session';

afterEach(() => vi.unstubAllGlobals());

function game(moves: readonly (readonly [number, number])[]): GameState {
  const value = create();
  for (const [x, y] of moves) expect(applyMove(value, x, y, currentColor(value)).ok).toBe(true);
  return value;
}
const opening = [[7, 7], [8, 7], [6, 6], [9, 8], [6, 8], [7, 9]] as const;
const options: AiOptions = { maxDepth: 4, maxNodes: 1600, vcfMaxNodes: 0, pnsMaxNodes: 0 };
function finish(session: AiSession): AiSession {
  for (let i = 0; i < 20000; i += 1) if (!session.step(1)) return session;
  throw new Error('search did not finish');
}

describe('实际对弈搜索使用 Rust/WASM 评分', () => {
  it('同一节点预算下落点、分数、深度和节点数与 TS 一致', () => {
    const input = game(opening);
    const snapshot = JSON.stringify(input);
    const ts = finish(createSearchSession(input, currentColor(input), options));
    const wasm = finish(createWasmSearchSession(input, currentColor(input), options));
    expect(wasm.stats().backend).toBe('rust-wasm');
    expect(wasm.result()).toEqual(ts.result());
    expect(wasm.stats()).toEqual({ ...ts.stats(), backend: 'rust-wasm' });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('交替推进两个 WASM 会话不会相互覆盖棋盘', () => {
    const inputs = [game(opening), game([...opening, [5, 8], [8, 9]])];
    const expected = inputs.map((g) => finish(createSearchSession(g, currentColor(g), options)).result());
    const sessions = inputs.map((g) => {
      let tick = 0;
      return createWasmSearchSession(g, currentColor(g), { ...options, timeBudgetMs: 1e9, now: () => tick++ });
    });
    for (let i = 0; i < 20000; i += 1) {
      const pending = sessions.map((session) => session.step(1));
      if (pending.every((value) => !value)) break;
    }
    expect(sessions.map((session) => session.result())).toEqual(expected);
    expect(sessions.every((session) => session.stats().backend === 'rust-wasm')).toBe(true);
  });

  it('WASM 不可用或显式选择 TS 时返回 TS 实际后端', () => {
    const input = game(opening);
    const expected = finish(createSearchSession(input, 1, options)).result();
    const forced = finish(createWasmSearchSession(input, 1, { ...options, backend: 'ts' }));
    expect(forced.stats().backend).toBe('ts');
    expect(forced.result()).toEqual(expected);
    vi.stubGlobal('WebAssembly', undefined);
    const fallback = finish(createWasmSearchSession(input, 1, options));
    expect(fallback.stats().backend).toBe('ts');
    expect(fallback.result()).toEqual(expected);
  });

  it('零预算仍返回合法兜底，取消后保持已完成结果', () => {
    const input = game(opening);
    const session = createWasmSearchSession(input, 1, { ...options, maxNodes: 0 });
    finish(session);
    const move = session.result();
    expect(move).not.toBeNull();
    expect(input.board[move![1]]![move![0]]).toBe(0);
    session.abort();
    expect(session.step()).toBe(false);
    expect(session.result()).toEqual(move);
    expect(session.stats().proofStatus).toBe('unknown');
  });

  it('算杀生成的证书仍由独立 TS 规则检查器复验', () => {
    const input = game([[5, 7], [0, 0], [6, 7], [0, 2], [7, 5], [14, 14], [7, 6], [14, 12]]);
    const session = finish(createWasmSearchSession(input, 1, { maxNodes: 0, pnsMaxNodes: 10000 }));
    const stats = session.stats();
    expect(stats.backend).toBe('rust-wasm');
    expect(stats.proofStatus).toBe('win');
    expect(verifyWinningProof(input, 1, stats.winningProof)).toBe(true);
  });
});

it('增量落子、撤子与假设点分确实调用 WASM 且与 TS 保持一致', () => {
  const kernel = createKernel();
  expect(kernel.isWasm).toBe(true);
  const windows = vi.spyOn(kernel, 'windowScore');
  const points = vi.spyOn(kernel, 'pointScore');
  const board = Int8Array.from(game(opening).board.flat());
  const wasm = createPositionState(board, kernel);
  const ts = createPositionState(board);
  const assertEqual = (): void => {
    expect(wasm.dirScore).toEqual(ts.dirScore);
    expect(evalFor(wasm, 1)).toBe(evalFor(ts, 1));
    for (const at of [0, 95, 110, 111, 112, 113, 127, 224]) {
      for (const color of [1, 2] as const) expect(getHypoPointScore(wasm, at, color)).toBe(getHypoPointScore(ts, at, color));
    }
  };
  assertEqual();
  for (const [at, color] of [[125, 1], [143, 2]] as const) {
    placeStone(wasm, at, color); placeStone(ts, at, color); assertEqual();
  }
  for (const at of [143, 125]) { removeStone(wasm, at); removeStone(ts, at); assertEqual(); }
  expect(windows).toHaveBeenCalled();
  expect(points).toHaveBeenCalled();
});
