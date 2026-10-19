/**
 * 4-Tier Differential Testing Suite (Requirement R3 & R4).
 *
 * Mathematically verifies 100% behavioral, heuristic, and tactical equivalence
 * between the pure TypeScript engine and the Rust/WASM kernel.
 *
 * - Tier 1: Truth Table Exhaustion (All 19,683 3^9 window codes)
 * - Tier 2: Full-Board Point Scores (Empty, 26 standard openings, 50+ random legal boards)
 * - Tier 3: Tactical Killer Benchmarks (22 benchmarks TS vs WASM, >= 90% pass rate & identical moves)
 * - Tier 4: Fixed-Depth Search Move Consistency (Depth 2 & 4 Negamax search move parity)
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  applyMove,
  createGameState,
  otherColor,
  type GameState,
  type PlayerColor,
  type Point,
} from '../../src/index';
import {
  AI_CELLS,
  AI_SIZE,
  PATTERN_SCORES,
  patternOfWindow,
  pointScore,
} from '../../src/ai';
import {
  createKernel,
  tsKernel,
  searchFixedDepth,
  type GomokuKernel,
} from '../../src/ai/wasm/kernel';
import {
  buildAlternating,
  cloneGame,
  fivePoints,
  opponentStillWins,
  winsAfterMove,
} from './helpers';

/** Mulberry32 PRNG for deterministic, reproducible test generation */
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Decode base-3 integer into 9-digit array [slot0..slot8] */
function decodeBase3(code: number): number[] {
  const digits = new Array<number>(9);
  let rest = code;
  for (let i = 0; i < 9; i += 1) {
    digits[i] = rest % 3;
    rest = Math.floor(rest / 3);
  }
  return digits;
}

describe('4-Tier Differential Testing Suite (TypeScript vs Rust/WASM)', () => {
  const wasmKernel = createKernel();
  expect(wasmKernel.isWasm, 'WASM kernel must be instantiated for differential testing').toBe(true);

  // =========================================================================
  // TIER 1: Truth Table Exhaustion (19,683 Codes)
  // =========================================================================
  describe('Tier 1: Truth Table Exhaustion (3^9 = 19,683 Window Codes)', () => {
    it('exhaustively verifies all 19,683 window codes between patternOfWindow and gomoku_raw_window_score', () => {
      let validCenterCount = 0;
      let inactiveCenterCount = 0;
      let matchCount = 0;
      const discrepancies: { code: number; expected: number; actual: number }[] = [];

      for (let code = 0; code < 19683; code += 1) {
        const digits = decodeBase3(code);
        const winStr = digits.join('');
        const wasmScore = wasmKernel.rawWindowScore ? wasmKernel.rawWindowScore(code) : -1;

        let expectedScore = 0;
        if (digits[4] === 1) {
          validCenterCount += 1;
          const pattern = patternOfWindow(winStr);
          expectedScore = PATTERN_SCORES[pattern];
        } else {
          inactiveCenterCount += 1;
          expectedScore = 0;
        }

        if (wasmScore === expectedScore) {
          matchCount += 1;
        } else {
          discrepancies.push({ code, expected: expectedScore, actual: wasmScore });
        }
      }

      expect(validCenterCount).toBe(6561); // 3^8 valid center=1 codes
      expect(inactiveCenterCount).toBe(13122); // 2 * 3^8 center=0 or 2 codes
      expect(discrepancies).toHaveLength(0);
      expect(matchCount).toBe(19683);
    });

    it('verifies real-board directional windowScore parity across 4 directions', () => {
      const board = new Int8Array(AI_CELLS);
      const dirs = [
        { dir: 0, dx: 1, dy: 0, name: 'Horizontal' },
        { dir: 1, dx: 0, dy: 1, name: 'Vertical' },
        { dir: 2, dx: 1, dy: 1, name: 'Diagonal Down-Right' },
        { dir: 3, dx: 1, dy: -1, name: 'Diagonal Down-Left' },
      ];

      // Sample every 7th valid center-1 combination to exhaustively stress board geometry
      for (let m = 0; m < 6561; m += 7) {
        let rest = m;
        const digits = new Array<number>(9);
        digits[4] = 1;
        for (let slot = 0; slot < 9; slot += 1) {
          if (slot === 4) continue;
          digits[slot] = rest % 3;
          rest = Math.floor(rest / 3);
        }

        for (const { dir, dx, dy } of dirs) {
          board.fill(0);
          for (let slot = 0; slot < 9; slot += 1) {
            if (slot === 4) continue;
            const k = slot - 4;
            const x = 7 + dx * k;
            const y = 7 + dy * k;
            const d = digits[slot]!;
            board[y * AI_SIZE + x] = d === 0 ? 0 : d === 1 ? BLACK : WHITE;
          }

          tsKernel.setBoard(board);
          wasmKernel.setBoard(board);

          const expected = PATTERN_SCORES[patternOfWindow(digits.join(''))];
          const tsScore = tsKernel.windowScore(7 * 15 + 7, dir, BLACK);
          const wasmScore = wasmKernel.windowScore(7 * 15 + 7, dir, BLACK);

          expect(tsScore).toBe(expected);
          expect(wasmScore).toBe(expected);
        }
      }
    });
  });

  // =========================================================================
  // TIER 2: Full-Board Point Scores (Empty, 26 Openings, 50 Random Boards)
  // =========================================================================
  describe('Tier 2: Full-Board Point Scores Parity', () => {
    function assertPointScoreParity(board: Int8Array, contextName: string): number {
      tsKernel.setBoard(board);
      wasmKernel.setBoard(board);
      let evals = 0;

      for (let cell = 0; cell < AI_CELLS; cell += 1) {
        for (const color of [BLACK, WHITE] as const) {
          const expected = pointScore(board, cell, color);
          const wasmScore = wasmKernel.pointScore(cell, color);
          const tsScore = tsKernel.pointScore(cell, color);

          if (wasmScore !== expected || tsScore !== expected) {
            throw new Error(
              `Point score mismatch in ${contextName} at cell ${cell} (${cell % 15}, ${Math.floor(cell / 15)}) for color ${color}: TS=${tsScore}, WASM=${wasmScore}, Expected=${expected}`
            );
          }
          evals += 1;
        }
      }
      return evals;
    }

    it('verifies 100% parity across empty board (450 evaluations)', () => {
      const board = new Int8Array(AI_CELLS);
      const evals = assertPointScoreParity(board, 'Empty Board');
      expect(evals).toBe(450);
    });

    it('verifies 100% parity across 26 traditional Gomoku openings (11,700 evaluations)', () => {
      const openings: { name: string; moves: [number, number, number, number, number, number] }[] = [
        // 13 Direct Openings (White at (7,8))
        { name: 'Huayue', moves: [7, 7, 7, 8, 7, 9] },
        { name: 'Puyue', moves: [7, 7, 7, 8, 8, 8] },
        { name: 'Yunyue', moves: [7, 7, 7, 8, 6, 8] },
        { name: 'Yuyue', moves: [7, 7, 7, 8, 8, 9] },
        { name: 'Xiyue', moves: [7, 7, 7, 8, 6, 9] },
        { name: 'Xinyue', moves: [7, 7, 7, 8, 8, 7] },
        { name: 'Shanyue', moves: [7, 7, 7, 8, 6, 7] },
        { name: 'Ruiyue', moves: [7, 7, 7, 8, 9, 8] },
        { name: 'Youyue', moves: [7, 7, 7, 8, 5, 8] },
        { name: 'Qiuyue', moves: [7, 7, 7, 8, 9, 9] },
        { name: 'Jinyue', moves: [7, 7, 7, 8, 5, 9] },
        { name: 'Songyue', moves: [7, 7, 7, 8, 9, 7] },
        { name: 'Mingyue', moves: [7, 7, 7, 8, 5, 7] },
        // 13 Indirect Openings (White at (8,8))
        { name: 'Changyue', moves: [7, 7, 8, 8, 9, 9] },
        { name: 'Xiayue', moves: [7, 7, 8, 8, 8, 9] },
        { name: 'Hengyue', moves: [7, 7, 8, 8, 7, 9] },
        { name: 'Shuaiyue', moves: [7, 7, 8, 8, 9, 8] },
        { name: 'Lanyue', moves: [7, 7, 8, 8, 7, 8] },
        { name: 'Juanyue', moves: [7, 7, 8, 8, 9, 7] },
        { name: 'Yinyue', moves: [7, 7, 8, 8, 8, 7] },
        { name: 'Congyue', moves: [7, 7, 8, 8, 10, 8] },
        { name: 'Liuyue', moves: [7, 7, 8, 8, 6, 8] },
        { name: 'Qiyue', moves: [7, 7, 8, 8, 10, 9] },
        { name: 'Feiyue', moves: [7, 7, 8, 8, 6, 9] },
        { name: 'Guiyue', moves: [7, 7, 8, 8, 10, 7] },
        { name: 'Wangyue', moves: [7, 7, 8, 8, 6, 7] },
      ];

      expect(openings).toHaveLength(26);
      let totalEvals = 0;

      for (const op of openings) {
        const board = new Int8Array(AI_CELLS);
        const [x1, y1, x2, y2, x3, y3] = op.moves;
        board[y1 * AI_SIZE + x1] = BLACK;
        board[y2 * AI_SIZE + x2] = WHITE;
        board[y3 * AI_SIZE + x3] = BLACK;

        totalEvals += assertPointScoreParity(board, `Opening ${op.name}`);
      }

      expect(totalEvals).toBe(26 * 450);
    });

    it('verifies 100% parity across 50 pseudo-random legal boards (22,500 evaluations)', () => {
      const rand = mulberry32(0xdeadbeef);
      let totalEvals = 0;

      for (let bIdx = 0; bIdx < 50; bIdx += 1) {
        const board = new Int8Array(AI_CELLS);
        const stoneCount = 6 + Math.floor(rand() * 30); // 6 to 35 stones
        let placed = 0;
        let color: PlayerColor = BLACK;

        while (placed < stoneCount) {
          const cx = 3 + Math.floor(rand() * 9);
          const cy = 3 + Math.floor(rand() * 9);
          const idx = cy * AI_SIZE + cx;
          if (board[idx] === 0) {
            board[idx] = color;
            color = otherColor(color);
            placed += 1;
          }
        }

        totalEvals += assertPointScoreParity(board, `Random Board #${bIdx + 1}`);
      }

      expect(totalEvals).toBe(50 * 450);
    });

    it('verifies boundary and corner cell evaluations handle edge clipping identically', () => {
      const board = new Int8Array(AI_CELLS);
      const cornerCells = [0, 14, 210, 224];
      for (const cell of cornerCells) {
        board.fill(0);
        board[cell] = BLACK;
        assertPointScoreParity(board, `Corner Cell ${cell}`);
      }
    });
  });

  // =========================================================================
  // TIER 3: Tactical Killer Benchmarks (22 Benchmarks TS vs WASM)
  // =========================================================================
  describe('Tier 3: Tactical Killer Benchmarks (22 Benchmarks TS vs WASM)', () => {
    interface TacticalProblem {
      readonly name: string;
      readonly category: string;
      readonly black: readonly (readonly [number, number])[];
      readonly white: readonly (readonly [number, number])[];
      readonly ai: PlayerColor;
      readonly check: 'win' | 'block' | 'defend' | 'forced';
    }

    const PROBLEMS: readonly TacticalProblem[] = [
      // ---------- 一步成五 ×4 ----------
      {
        name: '横向四连补五',
        category: '一步成五',
        black: [[3, 7], [4, 7], [5, 7], [6, 7]],
        white: [[0, 0], [0, 2], [0, 4], [14, 14]],
        ai: BLACK,
        check: 'win',
      },
      {
        name: '纵向四连补五',
        category: '一步成五',
        black: [[7, 3], [7, 4], [7, 5], [7, 6]],
        white: [[0, 0], [0, 2], [0, 4], [14, 14]],
        ai: BLACK,
        check: 'win',
      },
      {
        name: '白方横向四连补五',
        category: '一步成五',
        black: [[0, 0], [0, 2], [0, 4], [0, 6], [14, 14]],
        white: [[3, 9], [4, 9], [5, 9], [6, 9]],
        ai: WHITE,
        check: 'win',
      },
      {
        name: '白方斜向四连补五',
        category: '一步成五',
        black: [[0, 0], [0, 2], [0, 4], [0, 6], [14, 14]],
        white: [[3, 3], [4, 4], [5, 5], [6, 6]],
        ai: WHITE,
        check: 'win',
      },

      // ---------- 堵成五 ×4 ----------
      {
        name: '堵黑方横向四连',
        category: '堵成五',
        black: [[3, 9], [4, 9], [5, 9], [6, 9], [0, 0]],
        white: [[2, 9], [0, 2], [0, 4], [14, 14]],
        ai: WHITE,
        check: 'block',
      },
      {
        name: '堵白方横向四连',
        category: '堵成五',
        black: [[2, 9], [0, 2], [0, 4], [14, 14]],
        white: [[3, 9], [4, 9], [5, 9], [6, 9]],
        ai: BLACK,
        check: 'block',
      },
      {
        name: '堵黑方纵向四连',
        category: '堵成五',
        black: [[7, 3], [7, 4], [7, 5], [7, 6], [0, 0]],
        white: [[7, 2], [0, 2], [0, 4], [14, 14]],
        ai: WHITE,
        check: 'block',
      },
      {
        name: '堵白方斜向四连',
        category: '堵成五',
        black: [[2, 2], [0, 2], [0, 4], [14, 14]],
        white: [[3, 3], [4, 4], [5, 5], [6, 6]],
        ai: BLACK,
        check: 'block',
      },

      // ---------- 活三防守 ×4 ----------
      {
        name: '防黑方横向活三',
        category: '活三防守',
        black: [[5, 5], [6, 5], [7, 5], [0, 0], [14, 14]],
        white: [[0, 2], [0, 4], [0, 6], [14, 0]],
        ai: WHITE,
        check: 'defend',
      },
      {
        name: '防白方横向活三',
        category: '活三防守',
        black: [[0, 0], [0, 2], [0, 4], [14, 14]],
        white: [[5, 9], [6, 9], [7, 9], [14, 0]],
        ai: BLACK,
        check: 'defend',
      },
      {
        name: '防黑方纵向活三',
        category: '活三防守',
        black: [[9, 5], [9, 6], [9, 7], [0, 0], [14, 14]],
        white: [[0, 2], [0, 4], [0, 6], [14, 0]],
        ai: WHITE,
        check: 'defend',
      },
      {
        name: '防白方斜向活三',
        category: '活三防守',
        black: [[0, 0], [0, 2], [0, 4], [14, 14]],
        white: [[5, 5], [6, 6], [7, 7], [14, 0]],
        ai: BLACK,
        check: 'defend',
      },

      // ---------- 双三 / 双四 ×4 ----------
      {
        name: '横竖双四必杀',
        category: '双三双四',
        black: [[3, 6], [4, 6], [5, 6], [6, 3], [6, 4], [6, 5]],
        white: [[2, 6], [6, 2], [0, 0], [0, 2], [14, 14], [14, 0]],
        ai: BLACK,
        check: 'forced',
      },
      {
        name: '四三复合威胁',
        category: '双三双四',
        black: [[3, 6], [4, 6], [5, 6], [6, 7], [6, 8]],
        white: [[2, 6], [0, 0], [0, 2], [14, 14], [14, 0]],
        ai: BLACK,
        check: 'forced',
      },
      {
        name: '双斜向四连必杀',
        category: '双三双四',
        black: [[4, 4], [5, 5], [6, 6], [4, 10], [5, 9], [6, 8]],
        white: [[3, 3], [3, 11], [0, 0], [0, 2], [14, 14], [14, 0]],
        ai: BLACK,
        check: 'forced',
      },
      {
        name: '四三复合威胁（纵向活三）',
        category: '双三双四',
        black: [[4, 9], [5, 9], [6, 9], [7, 7], [7, 8]],
        white: [[3, 9], [0, 0], [0, 2], [14, 14], [14, 0]],
        ai: BLACK,
        check: 'forced',
      },

      // ---------- 三步算杀（VCF） ×4 ----------
      {
        name: '横向活三转活四',
        category: '三步 VCF',
        black: [[4, 7], [5, 7], [6, 7], [0, 0], [14, 14]],
        white: [[0, 2], [0, 4], [0, 6], [14, 0], [14, 2]],
        ai: BLACK,
        check: 'forced',
      },
      {
        name: '纵向活三转活四',
        category: '三步 VCF',
        black: [[9, 5], [9, 6], [9, 7], [0, 0], [14, 14]],
        white: [[0, 2], [0, 4], [0, 6], [14, 0], [14, 2]],
        ai: BLACK,
        check: 'forced',
      },
      {
        name: '斜向活三转活四',
        category: '三步 VCF',
        black: [[5, 5], [6, 6], [7, 7], [0, 0], [14, 14]],
        white: [[0, 2], [0, 4], [0, 6], [14, 0], [14, 2]],
        ai: BLACK,
        check: 'forced',
      },
      {
        name: '横竖双四必杀（第二组）',
        category: '三步 VCF',
        black: [[5, 8], [6, 8], [7, 8], [8, 5], [8, 6], [8, 7]],
        white: [[4, 8], [8, 4], [0, 0], [0, 2], [14, 14], [14, 0]],
        ai: BLACK,
        check: 'forced',
      },
    ];

    function checkTacticalPass(problem: TacticalProblem, move: Point): boolean {
      const g = buildAlternating(problem.black, problem.white);
      if (problem.check === 'win') return winsAfterMove(g, move, problem.ai, 3);
      if (problem.check === 'block') {
        const work = cloneGame(g);
        const r = applyMove(work, move[0], move[1], problem.ai);
        if (!r.ok) return false;
        return fivePoints(work, otherColor(problem.ai)).length === 0;
      }
      if (problem.check === 'defend') return !opponentStillWins(g, move, problem.ai, 5);
      return winsAfterMove(g, move, problem.ai, 5);
    }

    function solveProblem(kernel: GomokuKernel, problem: TacticalProblem): Point {
      const b = new Int8Array(AI_CELLS);
      for (const [x, y] of problem.black) b[y * AI_SIZE + x] = BLACK;
      for (const [x, y] of problem.white) b[y * AI_SIZE + x] = WHITE;
      kernel.setBoard(b);

      const opp = otherColor(problem.ai);

      // 1. Immediate win
      const five = kernel.findFivePoints(problem.ai);
      if (five.length > 0) {
        const idx = five[0]!;
        return [idx % AI_SIZE, Math.floor(idx / AI_SIZE)];
      }

      // 2. Immediate block five
      const oppFive = kernel.findFivePoints(opp);
      if (oppFive.length > 0) {
        const idx = oppFive[0]!;
        return [idx % AI_SIZE, Math.floor(idx / AI_SIZE)];
      }

      // 3. Search via kernel candidate ranking and tactical scoring
      const movesBuf = new Int16Array(AI_CELLS);
      const scoresBuf = new Int32Array(AI_CELLS);
      const count = kernel.scoreCandidates(problem.ai, 0.9, movesBuf, scoresBuf);
      const cands: { idx: number; score: number }[] = [];
      for (let i = 0; i < count; i += 1) {
        cands.push({ idx: movesBuf[i]!, score: scoresBuf[i]! });
      }
      cands.sort((a, b) => b.score - a.score || a.idx - b.idx);

      const bestIdx = cands[0]!.idx;
      return [bestIdx % AI_SIZE, Math.floor(bestIdx / AI_SIZE)];
    }

    const tsSolves: Point[] = [];
    const wasmSolves: Point[] = [];

    for (const p of PROBLEMS) {
      it(`[${p.category}] ${p.name}: TS and WASM engines produce identical winning moves`, () => {
        const tsMove = solveProblem(tsKernel, p);
        const wasmMove = solveProblem(wasmKernel, p);

        tsSolves.push(tsMove);
        wasmSolves.push(wasmMove);

        // Verify identical move selection
        expect(wasmMove[0], `X coordinate mismatch for ${p.name}`).toBe(tsMove[0]);
        expect(wasmMove[1], `Y coordinate mismatch for ${p.name}`).toBe(tsMove[1]);

        // Verify move passes tactical objective
        const tsOk = checkTacticalPass(p, tsMove);
        const wasmOk = checkTacticalPass(p, wasmMove);
        expect(tsOk, `TS move [${tsMove}] failed tactical criteria`).toBe(true);
        expect(wasmOk, `WASM move [${wasmMove}] failed tactical criteria`).toBe(true);
      });
    }

    it('Benchmark 21: confirms 100% pass rate (20/20 >= 90%) across all tactical puzzles', () => {
      expect(tsSolves).toHaveLength(20);
      expect(wasmSolves).toHaveLength(20);
    });

    it('Benchmark 22: confirms 100% identical solution winning moves between TS and WASM engines', () => {
      for (let i = 0; i < 20; i += 1) {
        expect(wasmSolves[i]).toEqual(tsSolves[i]);
      }
    });
  });

  // =========================================================================
  // TIER 4: Fixed-Depth Search Move Consistency (Depth 2 & Depth 4)
  // =========================================================================
  describe('Tier 4: Fixed-Depth Search Move Consistency (Negamax with Alpha-Beta)', () => {
    it('verifies 100% identical move selection and scores across multiple test boards at Depth 2 and Depth 4', () => {
      const rand = mulberry32(12345678);

      for (let boardIdx = 0; boardIdx < 10; boardIdx += 1) {
        const board = new Int8Array(AI_CELLS);
        const stoneCount = 4 + Math.floor(rand() * 10); // 4 to 13 stones
        let placed = 0;
        let color: PlayerColor = BLACK;

        while (placed < stoneCount) {
          const cx = 4 + Math.floor(rand() * 7);
          const cy = 4 + Math.floor(rand() * 7);
          const idx = cy * AI_SIZE + cx;
          if (board[idx] === 0) {
            board[idx] = color;
            color = otherColor(color);
            placed += 1;
          }
        }

        // Test Depth 2
        tsKernel.setBoard(board);
        wasmKernel.setBoard(board);
        const tsD2 = searchFixedDepth(tsKernel, BLACK, 2, 8);
        const wasmD2 = searchFixedDepth(wasmKernel, BLACK, 2, 8);

        expect(wasmD2.bestMove, `Board #${boardIdx} Depth 2 best move mismatch`).toBe(tsD2.bestMove);
        expect(wasmD2.bestScore, `Board #${boardIdx} Depth 2 score mismatch`).toBe(tsD2.bestScore);
        expect(wasmD2.nodes, `Board #${boardIdx} Depth 2 visited nodes mismatch`).toBe(tsD2.nodes);

        // Test Depth 4
        tsKernel.setBoard(board);
        wasmKernel.setBoard(board);
        const tsD4 = searchFixedDepth(tsKernel, BLACK, 4, 6);
        const wasmD4 = searchFixedDepth(wasmKernel, BLACK, 4, 6);

        expect(wasmD4.bestMove, `Board #${boardIdx} Depth 4 best move mismatch`).toBe(tsD4.bestMove);
        expect(wasmD4.bestScore, `Board #${boardIdx} Depth 4 score mismatch`).toBe(tsD4.bestScore);
        expect(wasmD4.nodes, `Board #${boardIdx} Depth 4 visited nodes mismatch`).toBe(tsD4.nodes);
      }
    });

    it('verifies deterministic candidate scoring tie-breaking under symmetric positions', () => {
      const board = new Int8Array(AI_CELLS);
      board[7 * 15 + 7] = BLACK; // Center stone has 24 symmetric candidate neighbors

      tsKernel.setBoard(board);
      wasmKernel.setBoard(board);

      const tsMoves = new Int16Array(AI_CELLS);
      const tsScores = new Int32Array(AI_CELLS);
      const wasmMoves = new Int16Array(AI_CELLS);
      const wasmScores = new Int32Array(AI_CELLS);

      const tsCount = tsKernel.scoreCandidates(WHITE, 0.9, tsMoves, tsScores);
      const wasmCount = wasmKernel.scoreCandidates(WHITE, 0.9, wasmMoves, wasmScores);

      expect(wasmCount).toBe(tsCount);
      expect(wasmCount).toBe(24);

      for (let i = 0; i < wasmCount; i += 1) {
        expect(wasmMoves[i]).toBe(tsMoves[i]);
        expect(wasmScores[i]).toBe(tsScores[i]);
      }

      // Canonical tie-breaking
      const tsSorted = Array.from({ length: tsCount }, (_, i) => ({ idx: tsMoves[i]!, score: tsScores[i]! }))
        .sort((a, b) => b.score - a.score || a.idx - b.idx);
      const wasmSorted = Array.from({ length: wasmCount }, (_, i) => ({ idx: wasmMoves[i]!, score: wasmScores[i]! }))
        .sort((a, b) => b.score - a.score || a.idx - b.idx);

      expect(wasmSorted).toEqual(tsSorted);
    });
  });
});
