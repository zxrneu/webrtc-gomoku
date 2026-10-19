import { describe, expect, it, vi } from 'vitest';
import { createKernel, searchFixedDepth } from '../../src/ai/wasm/kernel';

describe.each([true, false])('固定深度搜索 forceTs=%s', (forceTs) => {
  it('可被唯一应手化解的冲四不算必胜', () => {
    const board = new Int8Array(225);
    for (const at of [109, 110, 111]) board[at] = 1;
    for (const at of [108, 0, 224]) board[at] = 2;
    const kernel = createKernel({ forceTs });
    kernel.setBoard(board);
    expect(Math.abs(searchFixedDepth(kernel, 1, 2).bestScore)).toBeLessThan(9_000_000);
  });

  it('单个成五威胁必须实走堵点而不是返回必败分', () => {
    const board = new Int8Array(225);
    for (const at of [109, 110, 111, 112]) board[at] = 1;
    board[108] = 2;
    const kernel = createKernel({ forceTs });
    kernel.setBoard(board);
    const result = searchFixedDepth(kernel, 2, 1);
    expect(result.bestMove).toBe(113);
    expect(result.bestScore).toBeGreaterThan(-9_000_000);
  });

  it('对手两个成五点仍判定无法同时防守', () => {
    const board = new Int8Array(225);
    for (const at of [109, 110, 111, 112]) board[at] = 1;
    const kernel = createKernel({ forceTs });
    kernel.setBoard(board);
    expect(searchFixedDepth(kernel, 2, 2).bestScore).toBeLessThanOrEqual(-9_000_000);
  });

  it('拒绝非法参数并保持搜索有界', () => {
    const kernel = createKernel({ forceTs });
    kernel.setBoard(new Int8Array(225));
    for (const [color, depth, branches] of [[3, 2, 8], [1, -1, 8], [1, 33, 8], [1, 2, 0]]) {
      expect(searchFixedDepth(kernel, color!, depth!, branches!)).toEqual({ bestMove: -1, bestScore: 0, nodes: 0 });
    }
  });

  it('节点预算耗尽时停止并恢复棋盘', () => {
    const board = new Int8Array(225);
    board[112] = 1;
    board[127] = 2;
    const kernel = createKernel({ forceTs });
    kernel.setBoard(board);
    expect(searchFixedDepth(kernel, 1, 4, 8, 10).nodes).toBeLessThanOrEqual(10);
    const expected = createKernel({ forceTs: true });
    expected.setBoard(board);
    for (let at = 0; at < 225; at += 1) {
      expect(kernel.pointScore(at, 1)).toBe(expected.pointScore(at, 1));
    }
  });
});

it('WASM 搜索独立完成递归和叶点评估，不回调 TS 搜索辅助方法', () => {
  const board = new Int8Array(225);
  board[112] = 1;
  board[127] = 2;
  const wasm = createKernel();
  const ts = createKernel({ forceTs: true });
  wasm.setBoard(board);
  ts.setBoard(board);
  const expected = searchFixedDepth(ts, 1, 2);
  expect(wasm.isWasm).toBe(true);
  const candidates = vi.spyOn(wasm, 'scoreCandidates').mockImplementation(() => { throw new Error('TS candidate callback'); });
  const evaluate = vi.spyOn(wasm, 'evaluatePosition').mockImplementation(() => { throw new Error('TS evaluation callback'); });
  expect(searchFixedDepth(wasm, 1, 2)).toEqual(expected);
  expect(candidates).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
});
