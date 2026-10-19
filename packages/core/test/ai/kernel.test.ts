import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
} from '../../src/index';
import {
  AI_CELLS,
  PATTERN_SCORES,
  combineScores,
  patternOfWindow,
  pointScore,
  windowScoreAt,
} from '../../src/ai';
import { createKernel, getActiveKernel, tsKernel } from '../../src/ai/wasm/kernel';

function makeBoard(moves: readonly [number, number, 1 | 2][]): Int8Array {
  const b = new Int8Array(AI_CELLS);
  for (const [x, y, c] of moves) {
    b[y * 15 + x] = c;
  }
  return b;
}

describe('GomokuKernel (TS & WASM Dual-Track)', () => {
  describe('Provider & Fallback', () => {
    it('creates a default kernel without throwing', () => {
      const kernel = createKernel();
      expect(kernel).toBeDefined();
      expect(typeof kernel.pointScore).toBe('function');
      expect(typeof kernel.windowScore).toBe('function');
      expect(typeof kernel.combineScores).toBe('function');
    });

    it('provides a pure TypeScript fallback kernel', () => {
      expect(tsKernel.isWasm).toBe(false);
      const board = new Int8Array(AI_CELLS);
      board[112] = BLACK; // center (7, 7)
      tsKernel.setBoard(board);

      const score = tsKernel.pointScore(113, BLACK);
      expect(score).toBe(pointScore(board, 113, BLACK));
    });

    it('falls back seamlessly to tsKernel when WebAssembly is forced off', () => {
      const kernel = createKernel({ forceTs: true });
      expect(kernel.isWasm).toBe(false);
      const board = new Int8Array(AI_CELLS);
      board[112] = BLACK;
      kernel.setBoard(board);
      expect(kernel.pointScore(113, BLACK)).toBe(pointScore(board, 113, BLACK));
    });

    it('falls back seamlessly when given invalid wasm bytes', () => {
      const kernel = createKernel({ customWasmBase64: 'invalid_base64_data' });
      expect(kernel.isWasm).toBe(false);
    });

    it('exposes getActiveKernel() returning a functional kernel singleton', () => {
      const kernel = getActiveKernel();
      expect(kernel).toBeDefined();
      expect(typeof kernel.isWasm).toBe('boolean');
    });
  });

  describe('WASM Kernel Parity Verification', () => {
    it('initializes WASM kernel when WebAssembly is supported', () => {
      const kernel = createKernel();
      expect(kernel.isWasm).toBe(true);
      if (kernel.isWasm && kernel.getMovesBufferPtr && kernel.getScoresBufferPtr) {
        const movesPtr = kernel.getMovesBufferPtr();
        const scoresPtr = kernel.getScoresBufferPtr();
        expect(movesPtr).toBeGreaterThan(0);
        expect(scoresPtr).toBeGreaterThan(0);
        expect(movesPtr).not.toBe(scoresPtr);
        // 确保指针位于安全线性内存边界内，而非硬编码魔数 1130000
        expect(movesPtr).not.toBe(1130000);
        expect(scoresPtr).not.toBe(1131000);
      }
    });

    it('matches combineScores behavior identically', () => {
      const kernel = createKernel();
      const testCases: [number, number, number, number][] = [
        [0, 0, 0, 0],
        [10_000_000, 0, 0, 0],
        [1_000_000, 1_000_000, 0, 0],
        [100_000, 100_000, 0, 0], // double four
        [100_000, 20_000, 0, 0],  // four three
        [20_000, 20_000, 0, 0],   // double three
        [800, 120, 20, 0],
        [5_000, 800, 120, 20],
      ];

      for (const [d0, d1, d2, d3] of testCases) {
        const expected = combineScores(d0, d1, d2, d3);
        const actual = kernel.combineScores(d0, d1, d2, d3);
        expect(actual).toBe(expected);
      }
    });

    it('matches all valid center-1 window truth-table scores with patternOfWindow (Tier 1)', () => {
      const kernel = createKernel();
      expect(kernel.rawWindowScore).toBeDefined();

      const threePow = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];
      // 3^8 = 6561 combinations with center slot (slot 4) fixed to '1'
      for (let m = 0; m < 6561; m += 1) {
        let rest = m;
        const digits = new Array<number>(9);
        digits[4] = 1;
        let code = 1 * threePow[4]!;
        for (let slot = 0; slot < 9; slot += 1) {
          if (slot === 4) continue;
          const digit = rest % 3;
          rest = Math.floor(rest / 3);
          digits[slot] = digit;
          code += digit * threePow[slot]!;
        }
        const winStr = digits.join('');
        const expectedPattern = patternOfWindow(winStr);
        const expectedScore = PATTERN_SCORES[expectedPattern];
        const actualScore = kernel.rawWindowScore!(code);
        expect(actualScore).toBe(expectedScore);
      }
    });

    it('matches pointScore and windowScore across an empty board', () => {
      const kernel = createKernel();
      const board = new Int8Array(AI_CELLS);
      kernel.setBoard(board);

      for (const idx of [0, 7, 112, 224]) {
        for (const color of [BLACK, WHITE] as const) {
          for (let dir = 0; dir < 4; dir += 1) {
            const expectedWin = windowScoreAt(board, idx, dir, color);
            const actualWin = kernel.windowScore(idx, dir, color);
            expect(actualWin).toBe(expectedWin);
          }
          const expectedPt = pointScore(board, idx, color);
          const actualPt = kernel.pointScore(idx, color);
          expect(actualPt).toBe(expectedPt);
        }
      }
    });

    it('matches pointScore across realistic midgame positions (Tier 2)', () => {
      const kernel = createKernel();
      // Midgame board with cross-threats
      const moves: [number, number, 1 | 2][] = [
        [7, 7, 1], // Black center
        [7, 8, 2], // White
        [8, 6, 1],
        [6, 8, 2],
        [6, 6, 1],
        [8, 8, 2],
        [5, 5, 1],
        [9, 9, 2],
        [7, 6, 1],
        [7, 5, 2],
      ];
      const board = makeBoard(moves);
      kernel.setBoard(board);

      // Verify all 225 cells for both BLACK and WHITE
      for (let cell = 0; cell < AI_CELLS; cell += 1) {
        for (const color of [BLACK, WHITE] as const) {
          const expected = pointScore(board, cell, color);
          const actual = kernel.pointScore(cell, color);
          expect(actual).toBe(expected);
        }
      }
    });

    it('matches winsAt detection', () => {
      const kernel = createKernel();
      const moves: [number, number, 1 | 2][] = [
        [7, 3, 1],
        [7, 4, 1],
        [7, 5, 1],
        [7, 6, 1],
        [7, 7, 1], // 5 in a row vertically
      ];
      const board = makeBoard(moves);
      kernel.setBoard(board);

      expect(kernel.winsAt(7 * 15 + 7, BLACK)).toBe(true);
      expect(kernel.winsAt(6 * 15 + 7, BLACK)).toBe(true);
      expect(kernel.winsAt(8 * 15 + 7, BLACK)).toBe(false);
      expect(kernel.winsAt(7 * 15 + 7, WHITE)).toBe(false);
    });

    it('matches findFivePoints detection', () => {
      const kernel = createKernel();
      // 4 in a row vertically: 7,3 to 7,6. Winning points at (7,2) and (7,7)
      const moves: [number, number, 1 | 2][] = [
        [7, 3, 1],
        [7, 4, 1],
        [7, 5, 1],
        [7, 6, 1],
      ];
      const board = makeBoard(moves);
      kernel.setBoard(board);
      tsKernel.setBoard(board);

      const wasmWins = kernel.findFivePoints(BLACK).sort((a, b) => a - b);
      const tsWins = tsKernel.findFivePoints(BLACK).sort((a, b) => a - b);
      expect(wasmWins).toEqual(tsWins);
      expect(wasmWins).toContain(2 * 15 + 7);
      expect(wasmWins).toContain(7 * 15 + 7);
    });

    it('matches evaluatePosition between TS and WASM', () => {
      const kernel = createKernel();
      const moves: [number, number, 1 | 2][] = [
        [7, 7, 1],
        [7, 8, 2],
        [8, 6, 1],
        [6, 8, 2],
        [6, 6, 1],
      ];
      const board = makeBoard(moves);
      kernel.setBoard(board);
      tsKernel.setBoard(board);

      expect(kernel.evaluatePosition(BLACK)).toBe(tsKernel.evaluatePosition(BLACK));
      expect(kernel.evaluatePosition(WHITE)).toBe(tsKernel.evaluatePosition(WHITE));
    });

    it('matches scoreCandidates count and contents', () => {
      const kernel = createKernel();
      const moves: [number, number, 1 | 2][] = [
        [7, 7, 1],
        [7, 8, 2],
      ];
      const board = makeBoard(moves);
      kernel.setBoard(board);
      tsKernel.setBoard(board);

      const wasmMoves = new Int16Array(AI_CELLS);
      const wasmScores = new Int32Array(AI_CELLS);
      const wasmCount = kernel.scoreCandidates(BLACK, 1.1, wasmMoves, wasmScores);

      const tsMoves = new Int16Array(AI_CELLS);
      const tsScores = new Int32Array(AI_CELLS);
      const tsCount = tsKernel.scoreCandidates(BLACK, 1.1, tsMoves, tsScores);

      expect(wasmCount).toBe(tsCount);
      expect(wasmCount).toBeGreaterThan(0);
      for (let i = 0; i < wasmCount; i += 1) {
        expect(wasmMoves[i]).toBe(tsMoves[i]);
        expect(wasmScores[i]).toBe(tsScores[i]);
      }
    });

    it('correctly handles boundary / corner cells', () => {
      const kernel = createKernel();
      const board = new Int8Array(AI_CELLS);
      board[0] = BLACK;           // top-left (0, 0)
      board[14] = WHITE;          // top-right (14, 0)
      board[210] = BLACK;         // bottom-left (0, 14)
      board[224] = WHITE;         // bottom-right (14, 14)
      kernel.setBoard(board);

      // Verify no out-of-bounds crash or index errors
      for (const corner of [0, 14, 210, 224]) {
        for (const color of [BLACK, WHITE] as const) {
          const expected = pointScore(board, corner, color);
          const actual = kernel.pointScore(corner, color);
          expect(actual).toBe(expected);
        }
      }
    });

    it('supports direct memory writing via setCell and getBoardPtr', () => {
      const kernel = createKernel();
      kernel.setBoard(new Int8Array(AI_CELLS));
      kernel.setCell(112, BLACK);

      const board = new Int8Array(AI_CELLS);
      board[112] = BLACK;

      expect(kernel.pointScore(113, BLACK)).toBe(pointScore(board, 113, BLACK));
      if (kernel.getBoardPtr) {
        expect(kernel.getBoardPtr()).toBeGreaterThan(0);
      }
    });
  });
});
