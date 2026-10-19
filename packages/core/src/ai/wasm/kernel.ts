/**
 * Gomoku Dual-Track Evaluation Kernel.
 *
 * Provides a unified GomokuKernel interface with:
 * 1. High-performance WebAssembly kernel instantiated from inlined base64 bytecode.
 * 2. Pure TypeScript authoritative fallback kernel for zero-dependency execution.
 *
 * Guarantees zero network requests and seamless graceful degradation.
 */

import type { AiBoard, PlayerColor } from '../types';
import { AI_CELLS, AI_SIZE, oppositeOf } from '../types';
import { combineScores, pointScore, windowScoreAt } from '../pattern';
import { createPositionState, evalFor } from '../evaluate';
import { winsAt } from '../proofRules';
import { WASM_BASE64 } from './kernelBinary';

/**
 * GomokuKernel contract for board evaluation and pattern scoring.
 */
export interface GomokuKernel {
  /** True if backed by WebAssembly, false if pure TypeScript fallback */
  readonly isWasm: boolean;

  /** Set the full 225-cell board state */
  setBoard(cells: AiBoard | Uint8Array | Int8Array): void;

  /** Set a single cell on the internal board (0 = empty, 1 = Black, 2 = White) */
  setCell(idx: number, color: number): void;

  /** Get pattern score for a cell in a given direction (0..3) */
  windowScore(idx: number, dir: number, color: number): number;

  /** Get combined 4-direction point score for placing `color` at `idx` */
  pointScore(idx: number, color: number): number;

  /** Combine 4 directional scores into a single point score */
  combineScores(s0: number, s1: number, s2: number, s3: number): number;

  /** Check if `color` forms a 5-in-a-row (or more) passing through `idx` */
  winsAt(idx: number, color: number): boolean;

  /** Find all empty points where placing `color` achieves Five (>= 10,000,000) */
  findFivePoints(color: number): number[];

  /** Evaluate the entire position from the perspective of `color` */
  evaluatePosition(color: number): number;

  /** Score candidate moves within Chebyshev distance <= 2 of existing stones */
  scoreCandidates(
    color: number,
    defenseWeight: number,
    outMoves: Int16Array,
    outScores: Int32Array
  ): number;

  /** Raw lookup in the 19,683 window scores table */
  rawWindowScore?(code: number): number;

  /** Get pointer to linear memory board buffer (WASM only) */
  getBoardPtr?(): number;

  /** Get pointer to candidates moves buffer in linear memory (WASM only) */
  getMovesBufferPtr?(): number;

  /** Get pointer to candidates scores buffer in linear memory (WASM only) */
  getScoresBufferPtr?(): number;
}

/**
 * Pure TypeScript implementation of GomokuKernel.
 */
export class TsKernel implements GomokuKernel {
  readonly isWasm = false;
  private readonly board: Int8Array = new Int8Array(AI_CELLS);

  setBoard(cells: AiBoard | Uint8Array | Int8Array): void {
    this.board.set(cells);
  }

  setCell(idx: number, color: number): void {
    if (idx >= 0 && idx < AI_CELLS) {
      this.board[idx] = color;
    }
  }

  windowScore(idx: number, dir: number, color: number): number {
    return windowScoreAt(this.board, idx, dir, color as PlayerColor);
  }

  pointScore(idx: number, color: number): number {
    return pointScore(this.board, idx, color as PlayerColor);
  }

  combineScores(s0: number, s1: number, s2: number, s3: number): number {
    return combineScores(s0, s1, s2, s3);
  }

  winsAt(idx: number, color: number): boolean {
    return winsAt(this.board, idx, color as PlayerColor);
  }

  findFivePoints(color: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < AI_CELLS; i += 1) {
      if (this.board[i] === 0) {
        if (pointScore(this.board, i, color as PlayerColor) >= 10_000_000) {
          out.push(i);
        }
      }
    }
    return out;
  }

  evaluatePosition(color: number): number {
    const st = createPositionState(this.board);
    return evalFor(st, color as PlayerColor);
  }

  scoreCandidates(
    color: number,
    defenseWeight: number,
    outMoves: Int16Array,
    outScores: Int32Array
  ): number {
    const opp = oppositeOf(color as PlayerColor);
    let count = 0;
    for (let idx = 0; idx < AI_CELLS; idx += 1) {
      if (this.board[idx] === 0) {
        const x = idx % AI_SIZE;
        const y = Math.floor(idx / AI_SIZE);
        let hasNeighbor = false;
        checkNeighbor: for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < AI_SIZE && ny < AI_SIZE) {
              if (this.board[ny * AI_SIZE + nx] !== 0) {
                hasNeighbor = true;
                break checkNeighbor;
              }
            }
          }
        }
        if (hasNeighbor) {
          const attack = pointScore(this.board, idx, color as PlayerColor);
          const defense = pointScore(this.board, idx, opp);
          const score = Math.round(attack + defense * defenseWeight);
          outMoves[count] = idx;
          outScores[count] = score;
          count += 1;
        }
      }
    }
    return count;
  }
}

/** Pre-instantiated singleton for TypeScript kernel */
export const tsKernel = new TsKernel();

interface GomokuWasmExports {
  memory: WebAssembly.Memory;
  gomoku_init(): void;
  gomoku_evaluate_position(color: number): number;
  gomoku_search(color: number, depth: number, branches: number, maxNodes: number): number;
  gomoku_search_score(): number;
  gomoku_search_nodes(): number;
  gomoku_set_cell(idx: number, color: number): void;
  gomoku_window_score(idx: number, dir: number, color: number): number;
  gomoku_point_score(idx: number, color: number): number;
  get_board_ptr(): number;
  get_candidates_moves_ptr?(): number;
  get_candidates_scores_ptr?(): number;
  gomoku_window_code(idx: number, dir: number, color: number): number;
  gomoku_raw_window_score(code: number): number;
  gomoku_combine_scores(d0: number, d1: number, d2: number, d3: number): number;
  gomoku_wins_at(idx: number, color: number): number;
  gomoku_find_five(color: number, out_buf: number, max_len: number): number;
  gomoku_score_candidates(
    color: number,
    defense_weight_pct: number,
    out_moves: number,
    out_scores: number
  ): number;
}

/**
 * WebAssembly implementation of GomokuKernel.
 */
export class WasmKernel implements GomokuKernel {
  readonly isWasm = true;
  private readonly exports: GomokuWasmExports;
  private readonly boardPtr: number;
  private readonly movesBufferPtr: number;
  private readonly scoresBufferPtr: number;

  constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as unknown as GomokuWasmExports;
    this.exports.gomoku_init();
    this.boardPtr = this.exports.get_board_ptr();
    this.movesBufferPtr = typeof this.exports.get_candidates_moves_ptr === 'function'
      ? this.exports.get_candidates_moves_ptr()
      : 1130000;
    this.scoresBufferPtr = typeof this.exports.get_candidates_scores_ptr === 'function'
      ? this.exports.get_candidates_scores_ptr()
      : 1131000;
  }

  private getBoardView(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, this.boardPtr, AI_CELLS);
  }

  getBoardPtr(): number {
    return this.boardPtr;
  }

  getMovesBufferPtr(): number {
    return this.movesBufferPtr;
  }

  getScoresBufferPtr(): number {
    return this.scoresBufferPtr;
  }

  setBoard(cells: AiBoard | Uint8Array | Int8Array): void {
    this.getBoardView().set(cells);
  }

  setCell(idx: number, color: number): void {
    this.exports.gomoku_set_cell(idx, color);
  }

  windowScore(idx: number, dir: number, color: number): number {
    return this.exports.gomoku_window_score(idx, dir, color);
  }

  pointScore(idx: number, color: number): number {
    return this.exports.gomoku_point_score(idx, color);
  }

  combineScores(s0: number, s1: number, s2: number, s3: number): number {
    return this.exports.gomoku_combine_scores(s0, s1, s2, s3);
  }

  winsAt(idx: number, color: number): boolean {
    return this.exports.gomoku_wins_at(idx, color) === 1;
  }

  findFivePoints(color: number): number[] {
    const out: number[] = [];
    const board = this.getBoardView();
    for (let idx = 0; idx < AI_CELLS; idx += 1) {
      if (board[idx] === 0) {
        if (this.exports.gomoku_point_score(idx, color) >= 10_000_000) {
          out.push(idx);
        }
      }
    }
    return out;
  }

  evaluatePosition(color: number): number {
    return this.exports.gomoku_evaluate_position(color);
  }

  scoreCandidates(
    color: number,
    defenseWeight: number,
    outMoves: Int16Array,
    outScores: Int32Array
  ): number {
    const weightPct = Math.round(defenseWeight * 100);
    const count = this.exports.gomoku_score_candidates(
      color,
      weightPct,
      this.movesBufferPtr,
      this.scoresBufferPtr
    );
    if (count > 0) {
      const movesView = new Int16Array(this.exports.memory.buffer, this.movesBufferPtr, count);
      const scoresView = new Int32Array(this.exports.memory.buffer, this.scoresBufferPtr, count);
      outMoves.set(movesView);
      outScores.set(scoresView);
    }
    return count;
  }

  /** Native Rust recursion; no callbacks into the TypeScript evaluator. */
  search(color: number, depth: number, branches: number, maxNodes: number): FixedDepthSearchResult {
    const bestMove = this.exports.gomoku_search(color, depth, branches, maxNodes);
    return { bestMove, bestScore: this.exports.gomoku_search_score(), nodes: this.exports.gomoku_search_nodes() };
  }

  rawWindowScore(code: number): number {
    return this.exports.gomoku_raw_window_score(code);
  }
}

export interface FixedDepthSearchResult {
  bestMove: number;
  bestScore: number;
  nodes: number;
}

/**
 * Fixed-depth Negamax search with alpha-beta pruning powered by a GomokuKernel.
 * Evaluates candidate moves, explores up to `branchLimit` branches per ply,
 * and handles immediate five / block five tactics deterministically.
 */
export function searchFixedDepth(
  kernel: GomokuKernel,
  color: number,
  depth: number,
  branchLimit = 8,
  maxNodes = 1_000_000,
): FixedDepthSearchResult {
  if ((color !== 1 && color !== 2) || !Number.isInteger(depth) || depth < 0 || depth > 32 ||
    !Number.isInteger(branchLimit) || branchLimit < 1 || branchLimit > AI_CELLS ||
    !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 1_000_000) {
    return { bestMove: -1, bestScore: 0, nodes: 0 };
  }
  if (kernel instanceof WasmKernel) return kernel.search(color, depth, branchLimit, maxNodes);
  const stats = { nodes: 0, maxNodes };
  const res = negamaxInternal(kernel, color, depth, -Infinity, Infinity, branchLimit, stats, depth);
  return {
    bestMove: res.bestMove,
    bestScore: res.bestScore,
    nodes: stats.nodes,
  };
}

function negamaxInternal(
  kernel: GomokuKernel,
  color: number,
  depth: number,
  alpha: number,
  beta: number,
  branchLimit: number,
  stats: { nodes: number; maxNodes: number },
  maxDepth: number
): { bestScore: number; bestMove: number } {
  if (stats.nodes >= stats.maxNodes) return { bestScore: kernel.evaluatePosition(color), bestMove: -1 };
  stats.nodes += 1;
  const opp = color === 1 ? 2 : 1;

  // Immediate win check for current player
  const five = kernel.findFivePoints(color);
  if (five.length > 0) {
    return { bestScore: 10_000_000 - (maxDepth - depth), bestMove: five[0]! };
  }

  // Immediate block check for opponent
  const oppFive = kernel.findFivePoints(opp);
  if (oppFive.length >= 2) {
    return { bestScore: -10_000_000 + (maxDepth - depth), bestMove: oppFive[0]! };
  }

  if (depth === 0) {
    return { bestScore: kernel.evaluatePosition(color), bestMove: -1 };
  }

  if (oppFive.length === 1) {
    const move = oppFive[0]!;
    kernel.setCell(move, color);
    try {
      const child = negamaxInternal(kernel, opp, depth - 1, -beta, -alpha, branchLimit, stats, maxDepth);
      return { bestScore: -child.bestScore, bestMove: move };
    } finally {
      kernel.setCell(move, 0);
    }
  }

  const movesBuf = new Int16Array(AI_CELLS);
  const scoresBuf = new Int32Array(AI_CELLS);
  const count = kernel.scoreCandidates(color, 0.9, movesBuf, scoresBuf);
  if (count === 0) {
    return { bestScore: kernel.evaluatePosition(color), bestMove: -1 };
  }

  // Canonical tie-breaking sort: score descending, then cell index ascending
  const candidates: { idx: number; score: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    candidates.push({ idx: movesBuf[i]!, score: scoresBuf[i]! });
  }
  candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const limit = Math.min(candidates.length, branchLimit);
  let bestScore = -Infinity;
  let bestMove = candidates[0]!.idx;

  for (let i = 0; i < limit; i += 1) {
    const move = candidates[i]!.idx;
    kernel.setCell(move, color);
    const res = negamaxInternal(kernel, opp, depth - 1, -beta, -alpha, branchLimit, stats, maxDepth);
    kernel.setCell(move, 0);
    const score = -res.bestScore;
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
    if (score > alpha) {
      alpha = score;
    }
    if (alpha >= beta || stats.nodes >= stats.maxNodes) {
      break;
    }
  }

  return { bestScore, bestMove };
}

declare const Buffer:
  | {
      from(str: string, encoding?: string): ArrayLike<number>;
    }
  | undefined;

/**
 * Convert base64 string to Uint8Array in both Node.js and Browser environments.
 */
export function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Backward-compatibility alias for decodeBase64 */
export const base64ToUint8Array = decodeBase64;

/**
 * Asynchronously instantiate a WebAssembly instance from raw bytes and imports.
 */
export async function instantiateKernelWasm(
  bytes: Uint8Array,
  imports: WebAssembly.Imports = {}
): Promise<WebAssembly.Instance> {
  const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer, imports);
  return 'instance' in result ? result.instance : result;
}

export interface CreateKernelOptions {
  forceTs?: boolean;
  customWasmBase64?: string;
  wasmBase64?: string;
}

export type KernelOptions = CreateKernelOptions;

/**
 * Create a GomokuKernel instance.
 * Automatically tries to instantiate WebAssembly kernel;
 * falls back seamlessly to TsKernel if WebAssembly is unavailable or fails.
 */
export function createKernel(options?: CreateKernelOptions): GomokuKernel {
  if (options?.forceTs) {
    return new TsKernel();
  }

  if (typeof WebAssembly === 'undefined') {
    return new TsKernel();
  }

  const base64 = options?.customWasmBase64 ?? options?.wasmBase64 ?? WASM_BASE64;
  if (!base64 || base64.length === 0) {
    return new TsKernel();
  }

  try {
    const wasmBytes = decodeBase64(base64);
    const wasmModule = new WebAssembly.Module(wasmBytes.buffer as ArrayBuffer);
    const instance = new WebAssembly.Instance(wasmModule, {});
    const wasmKernel = new WasmKernel(instance);

    // Smoke test to ensure WASM exports and memory behave properly
    const smokeScore = wasmKernel.combineScores(100, 200, 300, 400);
    if (smokeScore !== 400) {
      return new TsKernel();
    }
    return wasmKernel;
  } catch (_err) {
    // Graceful fallback to pure TypeScript kernel
    return new TsKernel();
  }
}

let activeKernelInstance: GomokuKernel | null = null;

/**
 * Returns the active GomokuKernel singleton.
 */
export function getActiveKernel(): GomokuKernel {
  if (!activeKernelInstance) {
    activeKernelInstance = createKernel();
  }
  return activeKernelInstance;
}
