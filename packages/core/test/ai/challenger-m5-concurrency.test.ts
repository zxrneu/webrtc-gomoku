/**
 * Challenger M5 Concurrency, Re-entrancy, Multi-instance Isolation & State Invariant Test Suite.
 *
 * Tier 5 Adversarial Coverage Hardening:
 * 1. Multi-instance isolation: Simultaneous independent WASM & TS instances, mutation isolation, distinct linear memory.
 * 2. Re-entrancy & sequential search calls: scratchpad buffers (scratchSeenMask, hypoValid, plyMoves, linear memory) resets.
 * 3. Tactical proof generation & verification: mathematical game proof soundness under high threat density.
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  applyMove,
  create,
  type PlayerColor,
} from '../../src/index';
import {
  AI_CELLS,
  AI_SIZE,
  analyzeThreats,
  createPositionState,
  createProofSession,
  createSearchSession,
  evalFor,
  findBestMove,
  generateMoves,
  loadWinningStrategy,
  placeStone,
  pointScore,
  removeStone,
  verifyWinningProof,
} from '../../src/ai';
import { getHypoPointScore } from '../../src/ai/evaluate';
import { createKernel, type GomokuKernel } from '../../src/ai/wasm/kernel';

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Challenger M5: Multi-Instance Isolation & Zero State Bleeding', () => {
  it('instantiates multiple independent WASM and TS kernels simultaneously with zero state bleeding', () => {
    const N = 10;
    const wasmKernels: GomokuKernel[] = [];
    const tsKernels: GomokuKernel[] = [];

    for (let i = 0; i < N; i += 1) {
      wasmKernels.push(createKernel());
      tsKernels.push(createKernel({ forceTs: true }));
    }

    const rng = mulberry32(54321);
    const boards: Int8Array[] = [];

    // Assign distinct pseudo-random boards
    for (let i = 0; i < N; i += 1) {
      const b = new Int8Array(AI_CELLS);
      const stoneCount = i * 3;
      let placed = 0;
      let c: PlayerColor = BLACK;
      while (placed < stoneCount) {
        const cell = Math.floor(rng() * AI_CELLS);
        if (b[cell] === 0) {
          b[cell] = c;
          c = (c === BLACK ? WHITE : BLACK) as PlayerColor;
          placed += 1;
        }
      }
      boards.push(b);
      wasmKernels[i]!.setBoard(b);
      tsKernels[i]!.setBoard(b);
    }

    // Verify initial parity between WASM and TS
    for (let i = 0; i < N; i += 1) {
      const evalW = wasmKernels[i]!.evaluatePosition(BLACK);
      const evalT = tsKernels[i]!.evaluatePosition(BLACK);
      expect(evalW).toBe(evalT);

      const fiveW = wasmKernels[i]!.findFivePoints(BLACK);
      const fiveT = tsKernels[i]!.findFivePoints(BLACK);
      expect(fiveW).toEqual(fiveT);
    }

    // Mutate instance k and assert all j != k remain unaffected
    for (let k = 0; k < N; k += 1) {
      const dirtyBoard = new Int8Array(AI_CELLS).fill(2); // Fill with WHITE
      wasmKernels[k]!.setBoard(dirtyBoard);
      tsKernels[k]!.setBoard(dirtyBoard);

      for (let j = 0; j < N; j += 1) {
        if (j === k) continue;
        const expectedBoard = boards[j]!;

        // Spot check points across board
        for (let idx = 0; idx < AI_CELLS; idx += 25) {
          expect(wasmKernels[j]!.pointScore(idx, BLACK)).toBe(tsKernels[j]!.pointScore(idx, BLACK));
        }

        expect(wasmKernels[j]!.evaluatePosition(BLACK)).toBe(tsKernels[j]!.evaluatePosition(BLACK));
      }

      // Restore
      wasmKernels[k]!.setBoard(boards[k]!);
      tsKernels[k]!.setBoard(boards[k]!);
    }
  });

  it('verifies concurrent interleaved operations across paired WASM and TS instances', () => {
    const W = createKernel();
    const T = createKernel({ forceTs: true });
    const rng = mulberry32(999);

    for (let step = 0; step < 200; step += 1) {
      const cell = Math.floor(rng() * AI_CELLS);
      const color = rng() < 0.5 ? BLACK : WHITE;

      W.setCell(cell, color);
      T.setCell(cell, color);

      const checkCell = Math.floor(rng() * AI_CELLS);
      expect(W.pointScore(checkCell, BLACK)).toBe(T.pointScore(checkCell, BLACK));
      expect(W.pointScore(checkCell, WHITE)).toBe(T.pointScore(checkCell, WHITE));
    }
  });
});

describe('Challenger M5: Re-Entrancy, Scratchpad Buffers & State Invariants', () => {
  it('scratchSeenMask and genTag cleanly rollover past 255 without retaining dirty state', () => {
    const b = new Int8Array(AI_CELLS);
    b[7 * 15 + 5] = BLACK;
    b[7 * 15 + 6] = BLACK;
    b[7 * 15 + 8] = BLACK;
    b[6 * 15 + 7] = BLACK;
    b[8 * 15 + 7] = BLACK;

    const baseThreats = analyzeThreats(b, 7 * 15 + 7, BLACK);
    expect(baseThreats.length).toBeGreaterThan(0);

    for (let i = 0; i < 600; i += 1) {
      const threats = analyzeThreats(b, 7 * 15 + 7, BLACK);
      expect(threats.length).toBe(baseThreats.length);
      for (let t = 0; t < threats.length; t += 1) {
        expect(threats[t]!.kind).toBe(baseThreats[t]!.kind);
        expect(threats[t]!.gain).toBe(baseThreats[t]!.gain);
        // Assert no duplicate stones or costs
        expect(new Set(threats[t]!.stones).size).toBe(threats[t]!.stones.length);
        expect(new Set(threats[t]!.rest).size).toBe(threats[t]!.rest.length);
      }
    }
  });

  it('hypoValid and hypoScore cache strictly invariant under random walk place/remove operations', () => {
    const st = createPositionState(new Int8Array(AI_CELLS));
    const rng = mulberry32(777);
    const history: { cell: number; color: PlayerColor }[] = [];

    for (let step = 0; step < 1000; step += 1) {
      const shouldPlace = history.length < 3 || (history.length < 30 && rng() < 0.65);
      if (shouldPlace) {
        let cell = Math.floor(rng() * AI_CELLS);
        while (st.cells[cell] !== 0) {
          cell = (cell + 1) % AI_CELLS;
        }
        const color = (history.length % 2 === 0 ? BLACK : WHITE) as PlayerColor;
        placeStone(st, cell, color);
        history.push({ cell, color });
      } else {
        const last = history.pop()!;
        removeStone(st, last.cell);
      }

      // Check hypo cache consistency
      if (step % 20 === 0) {
        for (let c = 0; c < AI_CELLS; c += 15) {
          for (const col of [BLACK, WHITE] as const) {
            const key = (c << 1) | (col - 1);
            if (st.hypoValid[key] === 1) {
              expect(st.hypoScore[key]).toBe(pointScore(st.cells, c, col));
            }
            expect(getHypoPointScore(st, c, col)).toBe(pointScore(st.cells, c, col));
          }
        }
      }
    }
  });

  it('interleaved search sessions produce bit-for-bit identical results to sequential execution', () => {
    const gameA = create();
    applyMove(gameA, 7, 7, BLACK);
    applyMove(gameA, 7, 6, WHITE);
    applyMove(gameA, 8, 7, BLACK);
    applyMove(gameA, 6, 7, WHITE);
    applyMove(gameA, 6, 6, BLACK);
    applyMove(gameA, 8, 8, WHITE);

    const gameB = create();
    applyMove(gameB, 7, 7, BLACK);
    applyMove(gameB, 8, 8, WHITE);
    applyMove(gameB, 7, 8, BLACK);
    applyMove(gameB, 6, 6, WHITE);
    applyMove(gameB, 8, 7, BLACK);
    applyMove(gameB, 6, 7, WHITE);

    // Sequential
    const sA_seq = createSearchSession(gameA, BLACK, { maxNodes: 400 });
    while (sA_seq.step(50)) {}
    const moveA_seq = sA_seq.result();
    const statsA_seq = sA_seq.stats();

    const sB_seq = createSearchSession(gameB, BLACK, { maxNodes: 400 });
    while (sB_seq.step(50)) {}
    const moveB_seq = sB_seq.result();
    const statsB_seq = sB_seq.stats();

    // Interleaved
    const sA_int = createSearchSession(gameA, BLACK, { maxNodes: 400 });
    const sB_int = createSearchSession(gameB, BLACK, { maxNodes: 400 });
    let doneA = false;
    let doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) doneA = !sA_int.step(16);
      if (!doneB) doneB = !sB_int.step(16);
    }
    const moveA_int = sA_int.result();
    const statsA_int = sA_int.stats();
    const moveB_int = sB_int.result();
    const statsB_int = sB_int.stats();

    expect(moveA_int).toEqual(moveA_seq);
    expect(statsA_int.nodes).toBe(statsA_seq.nodes);
    expect(moveB_int).toEqual(moveB_seq);
    expect(statsB_int.nodes).toBe(statsB_seq.nodes);
  }, 15000);

  it('sequential findBestMove calls on the same engine produce deterministic invariant outputs', () => {
    const game = create();
    applyMove(game, 7, 7, BLACK);
    applyMove(game, 7, 6, WHITE);
    applyMove(game, 8, 7, BLACK);
    applyMove(game, 6, 7, WHITE);
    applyMove(game, 6, 6, BLACK);
    applyMove(game, 8, 8, WHITE);

    const first = findBestMove(game, BLACK, { maxNodes: 200 });
    expect(first).not.toBeNull();

    for (let rep = 0; rep < 20; rep += 1) {
      const next = findBestMove(game, BLACK, { maxNodes: 200 });
      expect(next).toEqual(first);
    }
  });
});

describe('Challenger M5: Tactical Proof Generation & Mathematical Soundness under High Threat Density', () => {
  it('generates, verifies, and executes tactical proofs across high threat density positions', () => {
    const testCases: { name: string; moves: [number, number][] }[] = [
      {
        name: 'Double-Three Fork',
        moves: [[4, 7], [0, 0], [5, 7], [0, 1], [6, 7], [0, 2]],
      },
      {
        name: 'Double Four Cross',
        moves: [[7, 7], [0, 0], [7, 8], [0, 1], [7, 9], [0, 2], [5, 7], [1, 0], [6, 7], [1, 1]],
      },
      {
        name: 'Four-Three Dual Direction',
        moves: [[7, 7], [0, 0], [8, 8], [0, 1], [9, 9], [0, 2], [7, 8], [1, 0], [7, 9], [1, 1]],
      },
    ];

    for (const tc of testCases) {
      const g = create();
      for (const [x, y] of tc.moves) {
        applyMove(g, x, y, (g.moves.length % 2 === 0) ? BLACK : WHITE);
      }

      const pSession = createProofSession(g, BLACK, { algorithm: 'pn', mode: 'fours', maxNodes: 10000 });
      while (pSession.step(32)) {}
      const res = pSession.result();

      expect(res.status).toBe('win');
      if (res.status === 'win') {
        expect(verifyWinningProof(g, BLACK, res.proof)).toBe(true);
        const strat = loadWinningStrategy({
          format: 'gomoku-proof-v1',
          rules: 'freestyle-15',
          game: g,
          attacker: BLACK,
          proof: res.proof,
        });
        expect(strat).not.toBeNull();
        if (strat) {
          const move = strat.moveFor(g);
          expect(move).not.toBeNull();
        }
      }
    }
  });

  it('strictly rejects adversarial mutations of proof trees and certificate envelopes', () => {
    const g = create();
    applyMove(g, 4, 7, BLACK);
    applyMove(g, 0, 0, WHITE);
    applyMove(g, 5, 7, BLACK);
    applyMove(g, 0, 1, WHITE);
    applyMove(g, 6, 7, BLACK);
    applyMove(g, 0, 2, WHITE);

    const session = createProofSession(g, BLACK, { mode: 'fours' });
    while (session.step()) {}
    const res = session.result();
    expect(res.status).toBe('win');
    if (res.status !== 'win') return;

    const baseDoc = {
      format: 'gomoku-proof-v1',
      rules: 'freestyle-15',
      game: g,
      attacker: BLACK,
      proof: res.proof,
    };

    // 1. Out of bounds attack coordinate
    expect(verifyWinningProof(g, BLACK, { ...res.proof, at: 225 })).toBe(false);
    expect(loadWinningStrategy({ ...baseDoc, proof: { ...res.proof, at: 225 } })).toBeNull();

    // 2. Negative attack coordinate
    expect(verifyWinningProof(g, BLACK, { ...res.proof, at: -1 })).toBe(false);
    expect(loadWinningStrategy({ ...baseDoc, proof: { ...res.proof, at: -1 } })).toBeNull();

    // 3. Occupied cell attack coordinate
    expect(verifyWinningProof(g, BLACK, { ...res.proof, at: 4 * 15 + 7 })).toBe(false);
    expect(loadWinningStrategy({ ...baseDoc, proof: { ...res.proof, at: 4 * 15 + 7 } })).toBeNull();

    // 4. Illegal rule name
    expect(loadWinningStrategy({ ...baseDoc, rules: 'renju' })).toBeNull();

    // 5. Inverted attacker color
    expect(verifyWinningProof(g, WHITE, res.proof)).toBe(false);
    expect(loadWinningStrategy({ ...baseDoc, attacker: WHITE })).toBeNull();

    // 6. Forged Five on empty cell
    expect(verifyWinningProof(g, BLACK, { kind: 'five', at: 0 })).toBe(false);

    // 7. Forged Fork on empty cell
    expect(verifyWinningProof(g, BLACK, { kind: 'fork', at: 0 })).toBe(false);

    // 8. Branch with empty replies
    expect(verifyWinningProof(g, BLACK, { kind: 'branch', at: 7 * 15 + 7, replies: [] })).toBe(false);

    // 9. Cyclic proof reference
    const cyclic: any = { kind: 'force', at: 7 * 15 + 7, reply: 1, next: null };
    cyclic.next = cyclic;
    expect(verifyWinningProof(g, BLACK, cyclic)).toBe(false);

    // 10. Null / undefined proof
    expect(verifyWinningProof(g, BLACK, null)).toBe(false);
    expect(verifyWinningProof(g, BLACK, undefined)).toBe(false);
    expect(loadWinningStrategy(null)).toBeNull();
  });
});
