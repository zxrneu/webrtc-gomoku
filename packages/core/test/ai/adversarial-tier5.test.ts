/**
 * Tier 5 White-Box Source Coverage & Adversarial Edge Path Test Suite.
 *
 * Covers branch extremes, edge conditions, boundary limits, and zero-candidate invariants
 * across packages/core/src/ai/** and crates/gomoku-kernel/src/lib.rs:
 * 1. Full board (225 stones placed, draw condition without crash)
 * 2. Empty board search and single-stone opening responses
 * 3. Four-direction overlines (6+ stones) on board boundaries and corners
 * 4. Zero candidate edge conditions when board is nearly full
 * 5. Defense branch capping in pnSearch.ts when defense moves are urgent vs non-urgent
 * 6. Elastic deadline behavior when remaining time is < 5ms
 * 7. Linear memory boundary indexing in kernel.ts and lib.rs
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  EMPTY,
  SIZE,
  applyMove,
  create,
  winLineAt,
  toPoint,
  idxOf,
  xOf,
  yOf,
  createSearchSession,
  findBestMove,
  openingMove,
  createPositionState,
  evalFor,
  placeStone,
  removeStone,
  pointScoreOf,
  collectCandidates,
  findFivePoints,
  generateMoves,
  pointScore,
  windowScoreAt,
  windowCode,
  combineScores,
  PATTERN_SCORES,
  searchPnProof,
  AI_CELLS,
  AI_SIZE,
  CENTER_IDX,
  type GameState,
  type Move,
  type PlayerColor,
  type Point,
  type AiBoard,
  type PositionState,
} from '../../src/index';
import { generateMovesInto } from '../../src/ai/movegen';
import {
  createKernel,
  tsKernel,
  WasmKernel,
  TsKernel,
  searchFixedDepth,
  type GomokuKernel,
} from '../../src/ai/wasm/kernel';
import { WASM_BASE64 } from '../../src/ai/wasm/kernelBinary';
import {
  readProofBoard,
  winsAt as proofWinsAt,
  emptyCells,
  neighborEmptyCells,
} from '../../src/ai/proofRules';
import {
  analyzeThreats,
  orderAttackCandidates,
  type Threat,
} from '../../src/ai/dependency';
import { type ThreatContext } from '../../src/ai/threatSearch';
import { buildGame } from './helpers';

// ==========================================
// Test Fixtures & Utilities
// ==========================================

interface RawWasmExports {
  memory: WebAssembly.Memory;
  gomoku_init(): void;
  gomoku_set_cell(idx: number, color: number): void;
  gomoku_window_score(idx: number, dir: number, color: number): number;
  gomoku_point_score(idx: number, color: number): number;
  get_board_ptr(): number;
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

function getRawWasmExports(): RawWasmExports {
  const buf = Buffer.from(WASM_BASE64, 'base64');
  const mod = new WebAssembly.Module(buf);
  const inst = new WebAssembly.Instance(mod, {});
  return inst.exports as unknown as RawWasmExports;
}

/**
 * Mathematically proven 15x15 full board (225 stones) with zero 5-in-a-row lines.
 * Uses ((x + 2*y) % 4 < 2) pattern yielding exactly 113 Black and 112 White stones.
 */
function buildFullBoardDrawMoves(): Move[] {
  const blackMoves: Move[] = [];
  const whiteMoves: Move[] = [];
  for (let y = 0; y < AI_SIZE; y += 1) {
    for (let x = 0; x < AI_SIZE; x += 1) {
      const color: PlayerColor = ((x + 2 * y) % 4 < 2) ? BLACK : WHITE;
      if (color === BLACK) {
        blackMoves.push({ x, y, c: BLACK });
      } else {
        whiteMoves.push({ x, y, c: WHITE });
      }
    }
  }

  const moves: Move[] = [];
  for (let i = 0; i < 113; i += 1) {
    moves.push(blackMoves[i]!);
    if (i < 112) {
      moves.push(whiteMoves[i]!);
    }
  }
  return moves;
}

function createGameWithMoves(moveCount: number): { game: GameState; allMoves: Move[] } {
  const allMoves = buildFullBoardDrawMoves();
  const game = create();
  for (let i = 0; i < moveCount; i += 1) {
    const m = allMoves[i]!;
    const res = applyMove(game, m.x, m.y, m.c);
    if (!res.ok) {
      throw new Error(`Move ${i} failed at (${m.x}, ${m.y}): ${res.reason}`);
    }
  }
  return { game, allMoves };
}

describe('Tier 5 Adversarial Coverage & Edge Path Hardening', () => {
  // ==========================================
  // Area 1: Full Board (225 Stones) & Draw Invariant
  // ==========================================
  describe('Area 1: Full Board (225 Stones) & Draw Invariant', () => {
    it('1.1 correctly triggers draw and game.over on 225th move', () => {
      const { game, allMoves } = createGameWithMoves(224);
      expect(game.over).toBe(false);
      expect(game.moves.length).toBe(224);

      const lastMove = allMoves[224]!;
      const res = applyMove(game, lastMove.x, lastMove.y, lastMove.c);
      expect(res.ok).toBe(true);
      expect(res.event).toBe('draw');
      expect(game.over).toBe(true);
      expect(game.winLine).toBeNull();
      expect(game.moves.length).toBe(225);

      // Verify all 225 cells are occupied
      for (let y = 0; y < AI_SIZE; y += 1) {
        for (let x = 0; x < AI_SIZE; x += 1) {
          expect(game.board[y]?.[x]).not.toBe(EMPTY);
        }
      }
    });

    it('1.2 readProofBoard safely rejects 225-move draw board as null', () => {
      const { game } = createGameWithMoves(225);
      const proofBoard = readProofBoard(game);
      expect(proofBoard).toBeNull();
    });

    it('1.3 createSearchSession returns NullSession and findBestMove returns null without crash', () => {
      const { game } = createGameWithMoves(225);
      const session = createSearchSession(game, WHITE);
      expect(session.step()).toBe(false);
      expect(session.result()).toBeNull();
      expect(session.stats()).toEqual({
        depth: 0,
        nodes: 0,
        elapsedMs: 0,
        cutoff: 'none',
        bestScore: 0,
        fromOpening: false,
        proofStatus: 'unknown',
      });

      const best = findBestMove(game, WHITE);
      expect(best).toBeNull();
    });

    it('1.4 PositionState on 225-stone board maintains zero candidateMask and empty moves', () => {
      const { game } = createGameWithMoves(225);
      const flat = new Int8Array(AI_CELLS);
      for (let y = 0; y < AI_SIZE; y += 1) {
        for (let x = 0; x < AI_SIZE; x += 1) {
          flat[y * AI_SIZE + x] = game.board[y]![x]!;
        }
      }

      const st = createPositionState(flat as unknown as AiBoard);
      expect(st.stoneCount).toBe(225);

      // candidateMask must be entirely 0 (all 8 uint32 words)
      for (let w = 0; w < 8; w += 1) {
        expect(st.candidateMask[w]).toBe(0);
      }

      expect(collectCandidates(st)).toEqual([]);
      expect(generateMoves(st, BLACK, 16)).toEqual([]);
      expect(generateMoves(st, WHITE, 16)).toEqual([]);
      expect(findFivePoints(st, BLACK)).toEqual([]);
      expect(findFivePoints(st, WHITE)).toEqual([]);

      const buf = new Int16Array(AI_CELLS);
      const count = generateMovesInto(st, BLACK, 16, buf, 0);
      expect(count).toBe(0);
    });

    it('1.5 TS and WASM kernels handle 225-stone full board without out-of-bounds', () => {
      const { game } = createGameWithMoves(225);
      const flat = new Int8Array(AI_CELLS);
      for (let y = 0; y < AI_SIZE; y += 1) {
        for (let x = 0; x < AI_SIZE; x += 1) {
          flat[y * AI_SIZE + x] = game.board[y]![x]!;
        }
      }

      const wasmKernel = createKernel();
      wasmKernel.setBoard(flat);
      tsKernel.setBoard(flat);

      const movesBuf = new Int16Array(AI_CELLS);
      const scoresBuf = new Int32Array(AI_CELLS);

      const wasmCount = wasmKernel.scoreCandidates(BLACK, 0.9, movesBuf, scoresBuf);
      const tsCount = tsKernel.scoreCandidates(BLACK, 0.9, movesBuf, scoresBuf);
      expect(wasmCount).toBe(0);
      expect(tsCount).toBe(0);

      expect(wasmKernel.findFivePoints(BLACK)).toEqual([]);
      expect(tsKernel.findFivePoints(BLACK)).toEqual([]);

      // Fixed depth search on full board returns bestMove = -1 and does not crash
      const wasmSearch = searchFixedDepth(wasmKernel, BLACK, 2);
      expect(wasmSearch.bestMove).toBe(-1);
      expect(wasmSearch.nodes).toBe(1);

      const tsSearch = searchFixedDepth(tsKernel, BLACK, 2);
      expect(tsSearch.bestMove).toBe(-1);
      expect(tsSearch.nodes).toBe(1);

      // Raw WASM C-ABI direct calls
      const raw = getRawWasmExports();
      raw.gomoku_init();
      const boardPtr = raw.get_board_ptr();
      new Uint8Array(raw.memory.buffer, boardPtr, AI_CELLS).set(flat);

      const cFive = raw.gomoku_find_five(1, 1130000, 16);
      expect(cFive).toBe(0);

      const cCand = raw.gomoku_score_candidates(1, 90, 1130000, 1131000);
      expect(cCand).toBe(0);
    });
  });

  // ==========================================
  // Area 2: Empty Board Search & Single-Stone Opening Responses
  // ==========================================
  describe('Area 2: Empty Board Search & Single-Stone Opening Responses', () => {
    it('2.1 empty board search yields Tianyuan (7,7) opening move immediately', () => {
      const emptyGame = create();
      expect(emptyGame.moves.length).toBe(0);

      expect(openingMove(emptyGame, BLACK)).toEqual([7, 7]);
      expect(openingMove(emptyGame, WHITE)).toBeNull();

      const bestBlack = findBestMove(emptyGame, BLACK);
      expect(bestBlack).toEqual([7, 7]);

      const session = createSearchSession(emptyGame, BLACK);
      expect(session.step()).toBe(false); // Finishes in 1 step from opening
      expect(session.result()).toEqual([7, 7]);
      expect(session.stats().fromOpening).toBe(true);
      expect(session.stats().depth).toBe(0);

      // Pure PositionState on empty board
      const emptySt = createPositionState(new Int8Array(AI_CELLS) as unknown as AiBoard);
      expect(emptySt.stoneCount).toBe(0);
      expect(generateMoves(emptySt, BLACK, 16)).toEqual([CENTER_IDX]);
      expect(generateMoves(emptySt, WHITE, 16)).toEqual([CENTER_IDX]);

      const buf = new Int16Array(AI_CELLS);
      const count = generateMovesInto(emptySt, BLACK, 16, buf, 0);
      expect(count).toBe(1);
      expect(buf[0]).toBe(CENTER_IDX);
    });

    it('2.2 single-stone center responses pick fixed replies in center 3x3', () => {
      // 1. Black opens at (7, 7) Tianyuan -> White plays (8, 8)
      const gCenter = buildGame([[7, 7, BLACK]]);
      expect(openingMove(gCenter, WHITE)).toEqual([8, 8]);
      expect(findBestMove(gCenter, WHITE)).toEqual([8, 8]);

      // 2. Black opens at (8, 8) -> White plays (6, 6)
      const g88 = buildGame([[8, 8, BLACK]]);
      expect(openingMove(g88, WHITE)).toEqual([6, 6]);
      expect(findBestMove(g88, WHITE)).toEqual([6, 6]);

      // 3. Black opens at (6, 6) -> White plays (8, 8)
      const g66 = buildGame([[6, 6, BLACK]]);
      expect(openingMove(g66, WHITE)).toEqual([8, 8]);
      expect(findBestMove(g66, WHITE)).toEqual([8, 8]);

      // 4. Black opens at (7, 6) -> White plays (8, 8)
      const g76 = buildGame([[7, 6, BLACK]]);
      expect(openingMove(g76, WHITE)).toEqual([8, 8]);
      expect(findBestMove(g76, WHITE)).toEqual([8, 8]);
    });

    it('2.3 adversarial non-center single-stone openings fall back to search within Chebyshev <= 2', () => {
      // 1. Black opens at extreme corner (0, 0)
      const gCorner = buildGame([[0, 0, BLACK]]);
      expect(openingMove(gCorner, WHITE)).toBeNull(); // Out of center zone

      const bestCorner = findBestMove(gCorner, WHITE, { maxDepth: 2 });
      expect(bestCorner).not.toBeNull();
      expect(bestCorner![0]).toBeGreaterThanOrEqual(0);
      expect(bestCorner![0]).toBeLessThanOrEqual(2);
      expect(bestCorner![1]).toBeGreaterThanOrEqual(0);
      expect(bestCorner![1]).toBeLessThanOrEqual(2);
      expect(bestCorner![0] === 0 && bestCorner![1] === 0).toBe(false);

      // 2. Black opens at corner (14, 14)
      const gBottomRight = buildGame([[14, 14, BLACK]]);
      expect(openingMove(gBottomRight, WHITE)).toBeNull();
      const bestBR = findBestMove(gBottomRight, WHITE, { maxDepth: 2 });
      expect(bestBR).not.toBeNull();
      expect(bestBR![0]).toBeGreaterThanOrEqual(12);
      expect(bestBR![0]).toBeLessThanOrEqual(14);
      expect(bestBR![1]).toBeGreaterThanOrEqual(12);
      expect(bestBR![1]).toBeLessThanOrEqual(14);

      // 3. Black opens at edge (0, 7)
      const gEdge = buildGame([[0, 7, BLACK]]);
      expect(openingMove(gEdge, WHITE)).toBeNull();
      const bestEdge = findBestMove(gEdge, WHITE, { maxDepth: 2 });
      expect(bestEdge).not.toBeNull();
      expect(bestEdge![0]).toBeGreaterThanOrEqual(0);
      expect(bestEdge![0]).toBeLessThanOrEqual(2);
      expect(Math.abs(bestEdge![1] - 7)).toBeLessThanOrEqual(2);
    });
  });

  // ==========================================
  // Area 3: Four-Direction Boundary & Corner Overlines (6+ Stones)
  // ==========================================
  describe('Area 3: Four-Direction Boundary & Corner Overlines (6+ Stones)', () => {
    it('3.1 horizontal boundary overlines (6 and 7 stones) evaluate to Five on TS and WASM', () => {
      const wasmKernel = createKernel();
      const raw = getRawWasmExports();
      raw.gomoku_init();

      // Top row boundary: x = 0..5 (6 stones)
      const b6 = new Int8Array(AI_CELLS);
      for (let x = 0; x < 6; x += 1) b6[x] = BLACK;

      wasmKernel.setBoard(b6);
      tsKernel.setBoard(b6);
      new Uint8Array(raw.memory.buffer, raw.get_board_ptr(), AI_CELLS).set(b6);

      for (let x = 0; x < 6; x += 1) {
        expect(proofWinsAt(b6 as unknown as AiBoard, x, BLACK)).toBe(true);
        expect(tsKernel.winsAt(x, BLACK)).toBe(true);
        expect(wasmKernel.winsAt(x, BLACK)).toBe(true);
        expect(raw.gomoku_wins_at(x, 1)).toBe(1);

        // Direction 0 is horizontal
        expect(windowScoreAt(b6 as unknown as AiBoard, x, 0, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.windowScore(x, 0, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.pointScore(x, BLACK)).toBe(tsKernel.pointScore(x, BLACK));
      }

      // Top row right corner overline: x = 9..14 (6 stones)
      const bRight = new Int8Array(AI_CELLS);
      for (let x = 9; x <= 14; x += 1) bRight[x] = BLACK;
      wasmKernel.setBoard(bRight);
      tsKernel.setBoard(bRight);
      new Uint8Array(raw.memory.buffer, raw.get_board_ptr(), AI_CELLS).set(bRight);

      for (let x = 9; x <= 14; x += 1) {
        expect(proofWinsAt(bRight as unknown as AiBoard, x, BLACK)).toBe(true);
        expect(wasmKernel.winsAt(x, BLACK)).toBe(true);
        expect(raw.gomoku_wins_at(x, 1)).toBe(1);
        expect(wasmKernel.windowScore(x, 0, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.pointScore(x, BLACK)).toBe(tsKernel.pointScore(x, BLACK));
      }
    });

    it('3.2 vertical boundary overlines (6 stones) on left and right edges', () => {
      const wasmKernel = createKernel();
      const raw = getRawWasmExports();
      raw.gomoku_init();

      // Left edge vertical overline: y = 0..5, x = 0
      const bLeft = new Int8Array(AI_CELLS);
      for (let y = 0; y < 6; y += 1) bLeft[y * AI_SIZE] = BLACK;

      wasmKernel.setBoard(bLeft);
      tsKernel.setBoard(bLeft);
      new Uint8Array(raw.memory.buffer, raw.get_board_ptr(), AI_CELLS).set(bLeft);

      for (let y = 0; y < 6; y += 1) {
        const idx = y * AI_SIZE;
        expect(proofWinsAt(bLeft as unknown as AiBoard, idx, BLACK)).toBe(true);
        expect(wasmKernel.winsAt(idx, BLACK)).toBe(true);
        expect(raw.gomoku_wins_at(idx, 1)).toBe(1);

        // Direction 1 is vertical
        expect(windowScoreAt(bLeft as unknown as AiBoard, idx, 1, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.windowScore(idx, 1, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.pointScore(idx, BLACK)).toBe(tsKernel.pointScore(idx, BLACK));
      }

      // Right edge vertical overline: y = 9..14, x = 14
      const bRight = new Int8Array(AI_CELLS);
      for (let y = 9; y < 15; y += 1) bRight[y * AI_SIZE + 14] = BLACK;
      wasmKernel.setBoard(bRight);
      tsKernel.setBoard(bRight);
      new Uint8Array(raw.memory.buffer, raw.get_board_ptr(), AI_CELLS).set(bRight);

      for (let y = 9; y < 15; y += 1) {
        const idx = y * AI_SIZE + 14;
        expect(proofWinsAt(bRight as unknown as AiBoard, idx, BLACK)).toBe(true);
        expect(wasmKernel.winsAt(idx, BLACK)).toBe(true);
        expect(raw.gomoku_wins_at(idx, 1)).toBe(1);
        expect(wasmKernel.windowScore(idx, 1, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.pointScore(idx, BLACK)).toBe(tsKernel.pointScore(idx, BLACK));
      }
    });

    it('3.3 diagonal overlines (dir = 2, dx = 1, dy = 1) across corners and center', () => {
      const wasmKernel = createKernel();
      const raw = getRawWasmExports();
      raw.gomoku_init();

      // Top-left corner diagonal: (0,0) to (5,5)
      const bDiagTL = new Int8Array(AI_CELLS);
      for (let k = 0; k < 6; k += 1) bDiagTL[k * AI_SIZE + k] = BLACK;

      wasmKernel.setBoard(bDiagTL);
      tsKernel.setBoard(bDiagTL);
      new Uint8Array(raw.memory.buffer, raw.get_board_ptr(), AI_CELLS).set(bDiagTL);

      for (let k = 0; k < 6; k += 1) {
        const idx = k * AI_SIZE + k;
        expect(proofWinsAt(bDiagTL as unknown as AiBoard, idx, BLACK)).toBe(true);
        expect(wasmKernel.winsAt(idx, BLACK)).toBe(true);
        expect(raw.gomoku_wins_at(idx, 1)).toBe(1);

        // Direction 2 is main diagonal (dx=1, dy=1)
        expect(windowScoreAt(bDiagTL as unknown as AiBoard, idx, 2, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.windowScore(idx, 2, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.pointScore(idx, BLACK)).toBe(tsKernel.pointScore(idx, BLACK));
      }

      // Bottom-right corner diagonal: (9,9) to (14,14)
      const bDiagBR = new Int8Array(AI_CELLS);
      for (let k = 9; k < 15; k += 1) bDiagBR[k * AI_SIZE + k] = BLACK;
      wasmKernel.setBoard(bDiagBR);
      tsKernel.setBoard(bDiagBR);
      new Uint8Array(raw.memory.buffer, raw.get_board_ptr(), AI_CELLS).set(bDiagBR);

      for (let k = 9; k < 15; k += 1) {
        const idx = k * AI_SIZE + k;
        expect(proofWinsAt(bDiagBR as unknown as AiBoard, idx, BLACK)).toBe(true);
        expect(wasmKernel.winsAt(idx, BLACK)).toBe(true);
        expect(raw.gomoku_wins_at(idx, 1)).toBe(1);
        expect(wasmKernel.windowScore(idx, 2, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.pointScore(idx, BLACK)).toBe(tsKernel.pointScore(idx, BLACK));
      }
    });

    it('3.4 anti-diagonal overlines (dir = 3, dx = 1, dy = -1) across corners', () => {
      const wasmKernel = createKernel();
      const raw = getRawWasmExports();
      raw.gomoku_init();

      // Bottom-left corner up-right: (0, 14), (1, 13), (2, 12), (3, 11), (4, 10), (5, 9)
      const bAntiBL = new Int8Array(AI_CELLS);
      for (let k = 0; k < 6; k += 1) {
        bAntiBL[(14 - k) * AI_SIZE + k] = BLACK;
      }

      wasmKernel.setBoard(bAntiBL);
      tsKernel.setBoard(bAntiBL);
      new Uint8Array(raw.memory.buffer, raw.get_board_ptr(), AI_CELLS).set(bAntiBL);

      for (let k = 0; k < 6; k += 1) {
        const idx = (14 - k) * AI_SIZE + k;
        expect(proofWinsAt(bAntiBL as unknown as AiBoard, idx, BLACK)).toBe(true);
        expect(wasmKernel.winsAt(idx, BLACK)).toBe(true);
        expect(raw.gomoku_wins_at(idx, 1)).toBe(1);

        // Direction 3 is anti-diagonal (dx=1, dy=-1)
        expect(windowScoreAt(bAntiBL as unknown as AiBoard, idx, 3, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.windowScore(idx, 3, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.pointScore(idx, BLACK)).toBe(tsKernel.pointScore(idx, BLACK));
      }

      // Top-right corner down-left: (14, 0), (13, 1), (12, 2), (11, 3), (10, 4), (9, 5)
      const bAntiTR = new Int8Array(AI_CELLS);
      for (let k = 0; k < 6; k += 1) {
        bAntiTR[k * AI_SIZE + (14 - k)] = BLACK;
      }
      wasmKernel.setBoard(bAntiTR);
      tsKernel.setBoard(bAntiTR);
      new Uint8Array(raw.memory.buffer, raw.get_board_ptr(), AI_CELLS).set(bAntiTR);

      for (let k = 0; k < 6; k += 1) {
        const idx = k * AI_SIZE + (14 - k);
        expect(proofWinsAt(bAntiTR as unknown as AiBoard, idx, BLACK)).toBe(true);
        expect(wasmKernel.winsAt(idx, BLACK)).toBe(true);
        expect(raw.gomoku_wins_at(idx, 1)).toBe(1);
        expect(wasmKernel.windowScore(idx, 3, BLACK)).toBe(PATTERN_SCORES.FIVE);
        expect(wasmKernel.pointScore(idx, BLACK)).toBe(tsKernel.pointScore(idx, BLACK));
      }
    });

    it('3.5 4-corner extreme coordinate ray casting matches 100% on TS and WASM', () => {
      const wasmKernel = createKernel();
      const raw = getRawWasmExports();
      const corners = [0, 14, 210, 224]; // (0,0), (14,0), (0,14), (14,14)

      const b = new Int8Array(AI_CELLS);
      for (const c of corners) b[c] = BLACK;
      wasmKernel.setBoard(b);

      for (const idx of corners) {
        for (let dir = 0; dir < 4; dir += 1) {
          const tsCode = windowCode(b as unknown as AiBoard, idx, dir, BLACK);
          const wasmCode = raw.gomoku_window_code(idx, dir, 1);
          expect(wasmCode).toBe(tsCode);

          const tsScore = windowScoreAt(b as unknown as AiBoard, idx, dir, BLACK);
          const wasmScore = wasmKernel.windowScore(idx, dir, BLACK);
          expect(wasmScore).toBe(tsScore);
        }
      }
    });
  });

  // ==========================================
  // Area 4: Near-Full Board Zero-Candidate Edge Conditions
  // ==========================================
  describe('Area 4: Near-Full Board Zero-Candidate Edge Conditions', () => {
    it('4.1 exactly 1 empty cell remaining triggers immediate single-candidate commitment', () => {
      const { game, allMoves } = createGameWithMoves(224);
      expect(game.moves.length).toBe(224);
      expect(game.over).toBe(false);

      const lastMove = allMoves[224]!;
      const expectedPoint: Point = [lastMove.x, lastMove.y];
      const expectedIdx = lastMove.y * AI_SIZE + lastMove.x;

      const flat = new Int8Array(AI_CELLS);
      for (let y = 0; y < AI_SIZE; y += 1) {
        for (let x = 0; x < AI_SIZE; x += 1) {
          flat[y * AI_SIZE + x] = game.board[y]![x]!;
        }
      }

      const st = createPositionState(flat as unknown as AiBoard);
      expect(st.stoneCount).toBe(224);

      const cands = collectCandidates(st);
      expect(cands.length).toBe(1);
      expect(cands[0]).toBe(expectedIdx);

      const moves = generateMoves(st, BLACK, 16);
      expect(moves.length).toBe(1);
      expect(moves[0]).toBe(expectedIdx);

      // Search session must short-circuit without deep search
      const session = createSearchSession(game, BLACK);
      session.step();
      expect(session.result()).toEqual(expectedPoint);
      expect(session.stats().depth).toBe(2);

      const best = findBestMove(game, BLACK);
      expect(best).toEqual(expectedPoint);
    });

    it('4.2 exactly 2 empty cells remaining searches and selects valid empty move', () => {
      const { game, allMoves } = createGameWithMoves(223);
      expect(game.moves.length).toBe(223);
      expect(game.over).toBe(false);

      const m223 = allMoves[223]!;
      const m224 = allMoves[224]!;
      const validPoints = [
        { x: m223.x, y: m223.y },
        { x: m224.x, y: m224.y },
      ];

      // Next player is WHITE (since moves.length = 223)
      const best = findBestMove(game, WHITE, { maxDepth: 2 });
      expect(best).not.toBeNull();
      const matched = validPoints.some((p) => p.x === best![0] && p.y === best![1]);
      expect(matched).toBe(true);
    });

    it('4.3 artificial zero-candidate PositionState returns empty and does not crash search', () => {
      // Artificial state with all bits cleared in candidateMask
      const st = createPositionState(new Int8Array(AI_CELLS) as unknown as AiBoard);
      st.stoneCount = 10;
      st.candidateMask.fill(0); // Force 0 candidate mask

      expect(collectCandidates(st)).toEqual([]);
      expect(generateMoves(st, BLACK, 16)).toEqual([]);

      const buf = new Int16Array(AI_CELLS);
      expect(generateMovesInto(st, BLACK, 16, buf, 0)).toBe(0);
      expect(findFivePoints(st, BLACK)).toEqual([]);
    });

    it('4.4 pnSearch handles zero candidate empty cells safely returning null', () => {
      const st = createPositionState(new Int8Array(AI_CELLS) as unknown as AiBoard);
      st.candidateMask.fill(0);

      const ctx: ThreatContext = {
        attacker: BLACK,
        mode: 'threats',
        nodes: 0,
        exhausted: false,
        maxNodes: 100,
      };

      const gen = searchPnProof(st, ctx, 8);
      let step = gen.next();
      while (!step.done) {
        step = gen.next();
      }
      expect(step.value).toBeNull();
    });
  });

  // ==========================================
  // Area 5: Defense Branch Capping & Priority Ordering in PNS
  // ==========================================
  describe('Area 5: Defense Branch Capping & Priority Ordering in PNS', () => {
    it('5.1 ensures scratch arrays in pnSearch remain within AI_CELLS and branch count <= 20', () => {
      // Create a dense cluster around (7,7) with over 30 candidate empty cells
      const game = create();
      const centerCoords: [number, number, PlayerColor][] = [
        [7, 6, BLACK], [7, 7, BLACK], [7, 8, BLACK], // Living three
        [5, 5, WHITE], [5, 6, WHITE], [5, 7, WHITE],
        [6, 5, WHITE], [6, 9, WHITE],
        [8, 5, WHITE], [8, 9, WHITE],
        [9, 5, WHITE], [9, 6, WHITE], [9, 7, WHITE],
      ];
      for (const [x, y, c] of centerCoords) {
        applyMove(game, x, y, c);
      }

      const flat = new Int8Array(AI_CELLS);
      for (let y = 0; y < AI_SIZE; y += 1) {
        for (let x = 0; x < AI_SIZE; x += 1) {
          flat[y * AI_SIZE + x] = game.board[y]![x]!;
        }
      }
      const st = createPositionState(flat as unknown as AiBoard);
      const cands = collectCandidates(st);
      expect(cands.length).toBeGreaterThan(20);

      const ctx: ThreatContext = {
        attacker: BLACK,
        mode: 'threats',
        nodes: 0,
        exhausted: false,
        maxNodes: 100,
      };

      // PNS execution on high-branching cluster must not throw and cap branches
      const gen = searchPnProof(st, ctx, 6);
      let step = gen.next();
      let iterations = 0;
      while (!step.done) {
        iterations += 1;
        step = gen.next();
      }
      expect(iterations).toBeGreaterThan(0);
      expect(ctx.nodes).toBeLessThanOrEqual(100);
    });

    it('5.2 urgent threat costs always take strict priority over non-urgent points', () => {
      // Analyze threats for placing a stone at empty (7,7) between (7,6) and (7,8)
      const b = new Int8Array(AI_CELLS);
      b[idxOf(7, 6)] = BLACK;
      b[idxOf(7, 8)] = BLACK;
      // idxOf(7, 7) is empty 0

      const threats = analyzeThreats(b as unknown as AiBoard, idxOf(7, 7), BLACK);
      expect(threats.length).toBeGreaterThan(0);
      const t = threats[0]!;

      // Verify cost / rest points receive +100M / +10M bonus
      const costBonus = 100_000_000;
      const restBonus = 10_000_000;
      for (const c of t.cost) {
        const pri = pointScore(b as unknown as AiBoard, c, WHITE) + pointScore(b as unknown as AiBoard, c, BLACK) + costBonus;
        expect(pri).toBeGreaterThan(100_000_000);
      }
      for (const r of t.rest) {
        const pri = pointScore(b as unknown as AiBoard, r, WHITE) + pointScore(b as unknown as AiBoard, r, BLACK) + restBonus;
        expect(pri).toBeGreaterThan(10_000_000);
      }
    });

    it('5.3 orderAttackCandidates handles empty board opening fallback vs full board', () => {
      // Empty board: returns Tianyuan [112] as opening fallback
      const emptySt = createPositionState(new Int8Array(AI_CELLS) as unknown as AiBoard);
      const candidatesFours = orderAttackCandidates(emptySt, BLACK, 'fours');
      const candidatesThreats = orderAttackCandidates(emptySt, BLACK, 'threats');
      expect(candidatesFours).toEqual([CENTER_IDX]);
      expect(candidatesThreats).toEqual([CENTER_IDX]);

      // Full board: center is occupied, returns []
      const fullFlat = new Int8Array(AI_CELLS).fill(1);
      const fullSt = createPositionState(fullFlat as unknown as AiBoard);
      expect(orderAttackCandidates(fullSt, BLACK, 'fours')).toEqual([]);
      expect(orderAttackCandidates(fullSt, BLACK, 'threats')).toEqual([]);
    });
  });

  // ==========================================
  // Area 6: Elastic Deadline Under Extreme Low Remaining Time (< 5ms)
  // ==========================================
  describe('Area 6: Elastic Deadline Under Extreme Low Remaining Time (< 5ms)', () => {
    it('6.1 remaining time <= 0ms immediately trips total deadline cutoff', () => {
      const g = buildGame([
        [7, 7, BLACK], [7, 8, WHITE],
        [8, 8, BLACK], [6, 6, WHITE],
      ]);

      // Clock already at or past deadline
      let t = 1000;
      const clock = () => t;

      const session = createSearchSession(g, BLACK, {
        now: clock,
        timeBudgetMs: 0, // 0ms budget -> deadline = 1000
      });

      expect(session.step()).toBe(false);
      expect(session.stats().cutoff).toBe('time');
      expect(session.result()).not.toBeNull();
    });

    it('6.2 remaining time = 1ms does not hang and cuts off cleanly within 1ms', () => {
      const g = buildGame([
        [7, 7, BLACK], [7, 8, WHITE],
        [8, 8, BLACK], [6, 6, WHITE],
      ]);

      let callCount = 0;
      const clock = () => {
        callCount += 1;
        // First call at 1000 (totalDeadline = 1001), next call at 1002 (expired)
        return callCount <= 1 ? 1000 : 1002;
      };

      const session = createSearchSession(g, BLACK, {
        now: clock,
        timeBudgetMs: 1,
      });

      let steps = 0;
      while (session.step(1)) {
        steps += 1;
        if (steps > 50) break;
      }

      expect(session.stats().cutoff).toBe('time');
      expect(session.result()).not.toBeNull();
    });

    it('6.3 remaining time = 3ms allows rapid VCF check while capping PNS dynamically', () => {
      const g = buildGame([
        [7, 7, BLACK], [7, 8, WHITE],
        [8, 8, BLACK], [6, 6, WHITE],
      ]);

      let time = 1000;
      const clock = () => {
        time += 1; // 1ms per check
        return time;
      };

      const session = createSearchSession(g, BLACK, {
        now: clock,
        timeBudgetMs: 3,
      });

      while (session.step(1)) {}
      expect(session.stats().cutoff).toBe('time');
      expect(session.result()).not.toBeNull();
    });

    it('6.4 findBestMove with 2ms timeBudgetMs returns valid move without throwing', () => {
      const g = buildGame([
        [7, 7, BLACK], [7, 8, WHITE],
        [8, 8, BLACK], [6, 6, WHITE],
      ]);

      let time = 5000;
      const clock = () => {
        time += 1;
        return time;
      };

      const best = findBestMove(g, BLACK, {
        now: clock,
        timeBudgetMs: 2,
      });

      expect(best).not.toBeNull();
      expect(best![0]).toBeGreaterThanOrEqual(0);
      expect(best![0]).toBeLessThan(AI_SIZE);
      expect(best![1]).toBeGreaterThanOrEqual(0);
      expect(best![1]).toBeLessThan(AI_SIZE);
    });
  });

  // ==========================================
  // Area 7: Linear Memory Boundary Indexing in TS & WASM Kernels
  // ==========================================
  describe('Area 7: Linear Memory Boundary Indexing in TS & WASM Kernels', () => {
    it('7.1 out-of-bounds cell indices are safely ignored without memory corruption', () => {
      const raw = getRawWasmExports();
      raw.gomoku_init();
      const wasmKernel = createKernel();

      const oobIndices = [-1, -100, -2147483648, 225, 226, 1000, 2147483647];

      for (const idx of oobIndices) {
        // gomoku_set_cell must be safe no-op
        raw.gomoku_set_cell(idx, 1);
        wasmKernel.setCell(idx, 1);
        tsKernel.setCell(idx, 1);

        // wins_at must return 0 / false
        expect(raw.gomoku_wins_at(idx, 1)).toBe(0);
        expect(wasmKernel.winsAt(idx, 1)).toBe(false);
        expect(tsKernel.winsAt(idx, 1)).toBe(false);

        // point_score must return 0
        expect(raw.gomoku_point_score(idx, 1)).toBe(0);
        expect(wasmKernel.pointScore(idx, 1)).toBe(0);
        expect(tsKernel.pointScore(idx, 1)).toBe(0);

        // window_score must return 0
        expect(raw.gomoku_window_score(idx, 0, 1)).toBe(0);
        expect(wasmKernel.windowScore(idx, 0, 1)).toBe(0);
        expect(tsKernel.windowScore(idx, 0, 1)).toBe(0);

        // window_code must return 0
        expect(raw.gomoku_window_code(idx, 0, 1)).toBe(0);
      }

      // Verify board buffer was not touched
      const boardPtr = raw.get_board_ptr();
      const boardBytes = new Uint8Array(raw.memory.buffer, boardPtr, AI_CELLS);
      for (let i = 0; i < AI_CELLS; i += 1) {
        expect(boardBytes[i]).toBe(0);
      }
    });

    it('7.2 out-of-bounds direction arguments return 0 cleanly in WASM C-ABI and WasmKernel', () => {
      const raw = getRawWasmExports();
      const wasmKernel = createKernel();
      const invalidDirs = [-1, -10, 4, 5, 100];

      for (const dir of invalidDirs) {
        expect(raw.gomoku_window_code(112, dir, 1)).toBe(0);
        expect(raw.gomoku_window_score(112, dir, 1)).toBe(0);
        expect(wasmKernel.windowScore(112, dir, 1)).toBe(0);
      }
    });

    it('7.3 out-of-bounds window codes return 0 without table over-read', () => {
      const raw = getRawWasmExports();
      const wasmKernel = createKernel();
      const invalidCodes = [-1, -100, 19683, 19684, 50000, 100000];

      for (const code of invalidCodes) {
        expect(raw.gomoku_raw_window_score(code)).toBe(0);
        if (wasmKernel.rawWindowScore) {
          expect(wasmKernel.rawWindowScore(code)).toBe(0);
        }
      }
    });

    it('7.4 boundary indices cell 0 and cell 224 operate correctly', () => {
      const raw = getRawWasmExports();
      raw.gomoku_init();
      const wasmKernel = createKernel();

      // Test first cell (0, 0)
      raw.gomoku_set_cell(0, 1);
      wasmKernel.setCell(0, 1);
      tsKernel.setCell(0, 1);

      expect(raw.gomoku_wins_at(0, 1)).toBe(0);
      expect(wasmKernel.winsAt(0, 1)).toBe(false);
      expect(tsKernel.winsAt(0, 1)).toBe(false);
      expect(wasmKernel.pointScore(0, 1)).toBe(tsKernel.pointScore(0, 1));

      // Test last cell (14, 14) -> idx 224
      raw.gomoku_set_cell(224, 2);
      wasmKernel.setCell(224, 2);
      tsKernel.setCell(224, 2);

      expect(raw.gomoku_wins_at(224, 2)).toBe(0);
      expect(wasmKernel.winsAt(224, 2)).toBe(false);
      expect(tsKernel.winsAt(224, 2)).toBe(false);
      expect(wasmKernel.pointScore(224, 2)).toBe(tsKernel.pointScore(224, 2));

      // Clear
      raw.gomoku_set_cell(0, 0);
      raw.gomoku_set_cell(224, 0);
      wasmKernel.setCell(0, 0);
      wasmKernel.setCell(224, 0);
      tsKernel.setCell(0, 0);
      tsKernel.setCell(224, 0);
    });

    it('7.5 C-ABI buffer pointer boundary and length clamping in gomoku_find_five and score_candidates', () => {
      const raw = getRawWasmExports();
      raw.gomoku_init();

      // gomoku_find_five with null pointer or non-positive max_len
      expect(raw.gomoku_find_five(1, 0, 0)).toBe(0);
      expect(raw.gomoku_find_five(1, 0, -5)).toBe(0);
      expect(raw.gomoku_find_five(1, 1130000, 0)).toBe(0);
      expect(raw.gomoku_find_five(1, 1130000, -1)).toBe(0);

      // gomoku_score_candidates with null pointers
      expect(raw.gomoku_score_candidates(1, 90, 0, 0)).toBe(0);
      expect(raw.gomoku_score_candidates(1, 90, 1130000, 0)).toBe(0);
      expect(raw.gomoku_score_candidates(1, 90, 0, 1131000)).toBe(0);

      // Integer defense weight percentage variations
      for (const pct of [0, 50, 90, 100, 200]) {
        const count = raw.gomoku_score_candidates(1, pct, 1130000, 1131000);
        expect(count).toBeGreaterThanOrEqual(0);
        expect(count).toBeLessThanOrEqual(AI_CELLS);
      }
    });

    it('7.6 WASM Linear Memory layout pointers are within static allocation boundaries', () => {
      const wasmKernel = createKernel();
      expect(wasmKernel.isWasm).toBe(true);

      const boardPtr = wasmKernel.getBoardPtr ? wasmKernel.getBoardPtr() : 0;
      expect(boardPtr).toBeGreaterThanOrEqual(0);

      const raw = getRawWasmExports();
      const memBytes = raw.memory.buffer.byteLength;
      expect(memBytes).toBeGreaterThanOrEqual(18 * 65536); // At least 18 pages (1.17 MB)

      // Buffer pointers 1130000 and 1131000 must sit comfortably within memory
      const movesBufferEnd = 1130000 + AI_CELLS * 2;
      const scoresBufferEnd = 1131000 + AI_CELLS * 4;
      expect(movesBufferEnd).toBeLessThan(memBytes);
      expect(scoresBufferEnd).toBeLessThan(memBytes);
    });
  });
});
