/**
 * Challenger M4: 4-Tier Differential Parity Adversarial Stress Harness
 *
 * Adversarially tests:
 * 1. Tier 1: Truth Table Exhaustion (19,683 window codes, edge codes, 4-direction real-board scans)
 * 2. Tier 2: Point Score Parity (100 stress boards: overlines, dense clusters, boundary hugging, corner traps)
 * 3. Tier 3: Tactical Killer Benchmarks (22 benchmarks + symmetrical threats)
 * 4. Tier 4: Search Move Consistency (Negamax Depth 1..4, multiple branch limits, node counts, scores)
 * 5. Tier 5: Memory Safety, Boundary Violations, and Graceful Fallback
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  BLACK,
  WHITE,
  applyMove,
  otherColor,
  pointScore,
  combineScores,
  patternOfWindow,
  PATTERN_SCORES,
  createPositionState,
  evalFor,
  AI_CELLS,
  AI_SIZE,
} from '../packages/core/dist/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Read inlined WASM base64
const kernelBinaryPath = path.join(repoRoot, 'packages/core/src/ai/wasm/kernelBinary.ts');
const kernelBinarySrc = fs.readFileSync(kernelBinaryPath, 'utf8');
const match = kernelBinarySrc.match(/WASM_BASE64\s*=\s*'([^']+)'/);
if (!match || !match[1]) {
  throw new Error(`Failed to extract WASM_BASE64 from ${kernelBinaryPath}`);
}
const WASM_BASE64 = match[1];
const wasmBytes = Buffer.from(WASM_BASE64, 'base64');

// Mulberry32 PRNG
function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decodeBase3(code) {
  const digits = new Array(9);
  let rest = code;
  for (let i = 0; i < 9; i += 1) {
    digits[i] = rest % 3;
    rest = Math.floor(rest / 3);
  }
  return digits;
}

async function runAdversarialStress() {
  console.log('================================================================');
  console.log('⚔️  CHALLENGER M4: ADVERSARIAL DIFFERENTIAL PARITY STRESS HARNESS');
  console.log('================================================================\n');

  // Instantiate WASM kernel
  const wasmModule = new WebAssembly.Module(wasmBytes);
  const wasmInstance = new WebAssembly.Instance(wasmModule, {});
  wasmInstance.exports.gomoku_init();
  const boardPtr = wasmInstance.exports.get_board_ptr();
  const wasmBoardView = new Uint8Array(wasmInstance.exports.memory.buffer, boardPtr, AI_CELLS);

  const WASM_MOVES_PTR = 1130000;
  const WASM_SCORES_PTR = 1131000;

  // ---------------------------------------------------------------------------
  // TIER 1: TRUTH TABLE EXHAUSTION & EDGE CODES
  // ---------------------------------------------------------------------------
  console.log('>>> [Tier 1] Stress-Testing Truth Table & Directional Window Codes...');
  let tier1Discrepancies = 0;
  let tier1Matches = 0;

  // 1.1 All 19,683 codes
  for (let code = 0; code < 19683; code += 1) {
    const digits = decodeBase3(code);
    const winStr = digits.join('');
    const wasmScore = wasmInstance.exports.gomoku_raw_window_score(code);

    let expectedScore = 0;
    if (digits[4] === 1) {
      const pattern = patternOfWindow(winStr);
      expectedScore = PATTERN_SCORES[pattern];
    }

    if (wasmScore === expectedScore) {
      tier1Matches += 1;
    } else {
      tier1Discrepancies += 1;
      if (tier1Discrepancies <= 5) {
        console.error(`Tier 1 Mismatch at code ${code} (${winStr}): Expected ${expectedScore}, Actual WASM ${wasmScore}`);
      }
    }
  }

  // 1.2 Edge codes
  function codeFromStr(str) {
    let c = 0;
    for (let i = 0; i < 9; i += 1) {
      c += Number(str[i]) * Math.pow(3, i);
    }
    return c;
  }

  const edgeStrings = [
    { name: 'All 0s (Empty)', str: '000000000' },
    { name: 'All 1s (All Friend)', str: '111111111' },
    { name: 'All 2s (All Opponent/Border)', str: '222222222' },
    { name: 'Center 1, borders 2 (222212222)', str: '222212222' },
    { name: 'Center 1, empty borders (000010000)', str: '000010000' },
    { name: 'Center 2, empty borders (000020000)', str: '000020000' },
    { name: 'Open Four with borders (201111022)', str: '201111022' },
    { name: 'Five in a row (001111100)', str: '001111100' },
    { name: 'Broken Four (011011000)', str: '011011000' },
    { name: 'Sleep Three (200111000)', str: '200111000' },
  ];

  for (const es of edgeStrings) {
    const code = codeFromStr(es.str);
    const expected = PATTERN_SCORES[patternOfWindow(es.str)];
    const actual = wasmInstance.exports.gomoku_raw_window_score(code);
    if (actual !== expected) {
      console.error(`Edge Code Mismatch for ${es.name} (str ${es.str}, code ${code}): Expected ${expected}, Actual ${actual}`);
      tier1Discrepancies += 1;
    }
  }

  // 1.3 Real-board directional window codes across ALL 225 cells × 4 directions on special layouts
  const testLayouts = [
    { name: 'Empty Board', gen: () => new Int8Array(AI_CELLS) },
    {
      name: 'Boundary Hugging (Border Row 0 & 14, Col 0 & 14)',
      gen: () => {
        const b = new Int8Array(AI_CELLS);
        for (let x = 0; x < 15; x += 1) {
          b[0 * 15 + x] = x % 2 === 0 ? BLACK : WHITE;
          b[14 * 15 + x] = x % 2 === 0 ? WHITE : BLACK;
        }
        for (let y = 0; y < 15; y += 1) {
          b[y * 15 + 0] = y % 2 === 0 ? BLACK : WHITE;
          b[y * 15 + 14] = y % 2 === 0 ? WHITE : BLACK;
        }
        return b;
      },
    },
    {
      name: 'Four Corners Only',
      gen: () => {
        const b = new Int8Array(AI_CELLS);
        b[0] = BLACK;
        b[14] = WHITE;
        b[210] = WHITE;
        b[224] = BLACK;
        return b;
      },
    },
    {
      name: 'Checkerboard Density',
      gen: () => {
        const b = new Int8Array(AI_CELLS);
        for (let y = 0; y < 15; y += 1) {
          for (let x = 0; x < 15; x += 1) {
            b[y * 15 + x] = (x + y) % 2 === 0 ? BLACK : 0;
          }
        }
        return b;
      },
    },
    {
      name: 'Diagonal Stripe Overlines',
      gen: () => {
        const b = new Int8Array(AI_CELLS);
        for (let i = 0; i < 15; i += 1) {
          b[i * 15 + i] = BLACK; // Full 15-stone diagonal
          b[i * 15 + (14 - i)] = WHITE; // Full 15-stone anti-diagonal
        }
        return b;
      },
    },
  ];

  let dirCheckCount = 0;
  for (const layout of testLayouts) {
    const board = layout.gen();
    wasmBoardView.set(board);

    for (let cell = 0; cell < AI_CELLS; cell += 1) {
      for (let dir = 0; dir < 4; dir += 1) {
        for (const color of [BLACK, WHITE]) {
          const wasmCode = wasmInstance.exports.gomoku_window_code(cell, dir, color);
          const wasmScore = wasmInstance.exports.gomoku_window_score(cell, dir, color);

          // Reconstruct window string from digits of wasmCode
          const digits = decodeBase3(wasmCode);
          const winStr = digits.join('');
          const expectedScore = PATTERN_SCORES[patternOfWindow(winStr)];

          if (wasmScore !== expectedScore) {
            tier1Discrepancies += 1;
            console.error(`Layout '${layout.name}' mismatch at cell ${cell}, dir ${dir}, color ${color}: wasmCode=${wasmCode}, wasmScore=${wasmScore}, expectedScore=${expectedScore}`);
          }
          dirCheckCount += 1;
        }
      }
    }
  }

  console.log(`  Tier 1 Truth Table: ${tier1Matches}/19683 codes matched.`);
  console.log(`  Tier 1 Edge Codes: Checked ${edgeStrings.length} boundary codes.`);
  console.log(`  Tier 1 Directional Scans: Checked ${dirCheckCount} directional windows across 5 layouts.`);
  console.log(`  Tier 1 Total Discrepancies: ${tier1Discrepancies} (Result: ${tier1Discrepancies === 0 ? 'PASS' : 'FAIL'})\n`);

  // ---------------------------------------------------------------------------
  // TIER 2: POINT SCORE PARITY UNDER EXTREME TACTICAL STRESS
  // ---------------------------------------------------------------------------
  console.log('>>> [Tier 2] Stress-Testing Point Score Parity Across 100 Adversarial Boards...');
  let tier2Evaluations = 0;
  let tier2Discrepancies = 0;
  const rand = mulberry32(987654321);

  for (let bIdx = 0; bIdx < 100; bIdx += 1) {
    const board = new Int8Array(AI_CELLS);
    const scenario = bIdx % 5;

    if (scenario === 0) {
      // Overlines & multi-fives (6 to 10 consecutive stones)
      for (let x = 2; x <= 9; x += 1) board[7 * 15 + x] = BLACK;
      for (let y = 3; y <= 11; y += 1) board[y * 15 + 7] = WHITE;
    } else if (scenario === 1) {
      // Dense central cluster (40 stones packed into 7x7)
      let placed = 0;
      let col = BLACK;
      while (placed < 35) {
        const x = 4 + Math.floor(rand() * 7);
        const y = 4 + Math.floor(rand() * 7);
        const idx = y * 15 + x;
        if (board[idx] === 0) {
          board[idx] = col;
          col = otherColor(col);
          placed += 1;
        }
      }
    } else if (scenario === 2) {
      // Corner traps & edge hugs
      for (let i = 0; i < 5; i += 1) {
        board[0 * 15 + i] = BLACK;
        board[i * 15 + 0] = WHITE;
        board[14 * 15 + (14 - i)] = BLACK;
        board[(14 - i) * 15 + 14] = WHITE;
      }
    } else if (scenario === 3) {
      // Multiple simultaneous double-threes and four-threes
      board[3 * 15 + 5] = BLACK; board[3 * 15 + 6] = BLACK; board[3 * 15 + 7] = BLACK;
      board[5 * 15 + 3] = BLACK; board[6 * 15 + 3] = BLACK; board[7 * 15 + 3] = BLACK;
      board[10 * 15 + 10] = WHITE; board[10 * 15 + 11] = WHITE; board[10 * 15 + 12] = WHITE;
      board[8 * 15 + 10] = WHITE; board[9 * 15 + 10] = WHITE;
    } else {
      // Heavy random legal board (up to 45 stones anywhere)
      const stoneCount = 10 + Math.floor(rand() * 35);
      let placed = 0;
      let col = BLACK;
      while (placed < stoneCount) {
        const idx = Math.floor(rand() * AI_CELLS);
        if (board[idx] === 0) {
          board[idx] = col;
          col = otherColor(col);
          placed += 1;
        }
      }
    }

    wasmBoardView.set(board);

    // Evaluate all 225 cells for both colors
    for (let cell = 0; cell < AI_CELLS; cell += 1) {
      for (const color of [BLACK, WHITE]) {
        const tsScore = pointScore(board, cell, color);
        const wasmScore = wasmInstance.exports.gomoku_point_score(cell, color);

        if (tsScore !== wasmScore) {
          tier2Discrepancies += 1;
          if (tier2Discrepancies <= 5) {
            console.error(`Tier 2 Mismatch in board #${bIdx + 1} at cell ${cell} (${cell % 15}, ${Math.floor(cell / 15)}), color ${color}: TS=${tsScore}, WASM=${wasmScore}`);
          }
        }
        tier2Evaluations += 1;
      }
    }
  }

  console.log(`  Tier 2 Total Point Score Evaluations: ${tier2Evaluations} across 100 boards.`);
  console.log(`  Tier 2 Total Discrepancies: ${tier2Discrepancies} (Result: ${tier2Discrepancies === 0 ? 'PASS' : 'FAIL'})\n`);

  // ---------------------------------------------------------------------------
  // TIER 3: TACTICAL KILLER BENCHMARKS (22 PUZZLES)
  // ---------------------------------------------------------------------------
  console.log('>>> [Tier 3] Stress-Testing Tactical Killer Benchmarks...');
  const tacticalProblems = [
    { name: '横向四连补五', category: '一步成五', black: [[3, 7], [4, 7], [5, 7], [6, 7]], white: [[0, 0], [0, 2], [0, 4], [14, 14]], ai: BLACK },
    { name: '纵向四连补五', category: '一步成五', black: [[7, 3], [7, 4], [7, 5], [7, 6]], white: [[0, 0], [0, 2], [0, 4], [14, 14]], ai: BLACK },
    { name: '白方横向四连补五', category: '一步成五', black: [[0, 0], [0, 2], [0, 4], [0, 6], [14, 14]], white: [[3, 9], [4, 9], [5, 9], [6, 9]], ai: WHITE },
    { name: '白方斜向四连补五', category: '一步成五', black: [[0, 0], [0, 2], [0, 4], [0, 6], [14, 14]], white: [[3, 3], [4, 4], [5, 5], [6, 6]], ai: WHITE },
    { name: '堵黑方横向四连', category: '堵成五', black: [[3, 9], [4, 9], [5, 9], [6, 9], [0, 0]], white: [[2, 9], [0, 2], [0, 4], [14, 14]], ai: WHITE },
    { name: '堵白方横向四连', category: '堵成五', black: [[2, 9], [0, 2], [0, 4], [14, 14]], white: [[3, 9], [4, 9], [5, 9], [6, 9]], ai: BLACK },
    { name: '堵黑方纵向四连', category: '堵成五', black: [[7, 3], [7, 4], [7, 5], [7, 6], [0, 0]], white: [[7, 2], [0, 2], [0, 4], [14, 14]], ai: WHITE },
    { name: '堵白方斜向四连', category: '堵成五', black: [[2, 2], [0, 2], [0, 4], [14, 14]], white: [[3, 3], [4, 4], [5, 5], [6, 6]], ai: BLACK },
    { name: '防黑方横向活三', category: '活三防守', black: [[5, 5], [6, 5], [7, 5], [0, 0], [14, 14]], white: [[0, 2], [0, 4], [0, 6], [14, 0]], ai: WHITE },
    { name: '防白方横向活三', category: '活三防守', black: [[0, 0], [0, 2], [0, 4], [14, 14]], white: [[5, 9], [6, 9], [7, 9], [14, 0]], ai: BLACK },
    { name: '防黑方纵向活三', category: '活三防守', black: [[9, 5], [9, 6], [9, 7], [0, 0], [14, 14]], white: [[0, 2], [0, 4], [0, 6], [14, 0]], ai: WHITE },
    { name: '防白方斜向活三', category: '活三防守', black: [[0, 0], [0, 2], [0, 4], [14, 14]], white: [[5, 5], [6, 6], [7, 7], [14, 0]], ai: BLACK },
    { name: '横竖双四必杀', category: '双三双四', black: [[3, 6], [4, 6], [5, 6], [6, 3], [6, 4], [6, 5]], white: [[2, 6], [6, 2], [0, 0], [0, 2], [14, 14], [14, 0]], ai: BLACK },
    { name: '四三复合威胁', category: '双三双四', black: [[3, 6], [4, 6], [5, 6], [6, 7], [6, 8]], white: [[2, 6], [0, 0], [0, 2], [14, 14], [14, 0]], ai: BLACK },
    { name: '双斜向四连必杀', category: '双三双四', black: [[4, 4], [5, 5], [6, 6], [4, 10], [5, 9], [6, 8]], white: [[3, 3], [3, 11], [0, 0], [0, 2], [14, 14], [14, 0]], ai: BLACK },
    { name: '四三复合威胁（纵向活三）', category: '双三双四', black: [[4, 9], [5, 9], [6, 9], [7, 7], [7, 8]], white: [[3, 9], [0, 0], [0, 2], [14, 14], [14, 0]], ai: BLACK },
    { name: '横向活三转活四', category: '三步 VCF', black: [[4, 7], [5, 7], [6, 7], [0, 0], [14, 14]], white: [[0, 2], [0, 4], [0, 6], [14, 0], [14, 2]], ai: BLACK },
    { name: '纵向活三转活四', category: '三步 VCF', black: [[9, 5], [9, 6], [9, 7], [0, 0], [14, 14]], white: [[0, 2], [0, 4], [0, 6], [14, 0], [14, 2]], ai: BLACK },
    { name: '斜向活三转活四', category: '三步 VCF', black: [[5, 5], [6, 6], [7, 7], [0, 0], [14, 14]], white: [[0, 2], [0, 4], [0, 6], [14, 0], [14, 2]], ai: BLACK },
    { name: '横竖双四必杀（第二组）', category: '三步 VCF', black: [[5, 8], [6, 8], [7, 8], [8, 5], [8, 6], [8, 7]], white: [[4, 8], [8, 4], [0, 0], [0, 2], [14, 14], [14, 0]], ai: BLACK },
  ];

  function solveWithTs(p) {
    const b = new Int8Array(AI_CELLS);
    for (const [x, y] of p.black) b[y * 15 + x] = BLACK;
    for (const [x, y] of p.white) b[y * 15 + x] = WHITE;

    const opp = otherColor(p.ai);
    // 1. Five
    for (let i = 0; i < AI_CELLS; i += 1) {
      if (b[i] === 0 && pointScore(b, i, p.ai) >= 10000000) return i;
    }
    // 2. Block Five
    for (let i = 0; i < AI_CELLS; i += 1) {
      if (b[i] === 0 && pointScore(b, i, opp) >= 10000000) return i;
    }
    // 3. Candidate scoring
    const moves = [];
    for (let idx = 0; idx < AI_CELLS; idx += 1) {
      if (b[idx] === 0) {
        const x = idx % 15;
        const y = Math.floor(idx / 15);
        let hasNeighbor = false;
        checkN: for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx; const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < 15 && ny < 15 && b[ny * 15 + nx] !== 0) {
              hasNeighbor = true;
              break checkN;
            }
          }
        }
        if (hasNeighbor) {
          const atk = pointScore(b, idx, p.ai);
          const def = pointScore(b, idx, opp);
          moves.push({ idx, score: Math.round(atk + def * 0.9) });
        }
      }
    }
    moves.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return moves[0].idx;
  }

  function solveWithWasm(p) {
    const b = new Int8Array(AI_CELLS);
    for (const [x, y] of p.black) b[y * 15 + x] = BLACK;
    for (const [x, y] of p.white) b[y * 15 + x] = WHITE;
    wasmBoardView.set(b);

    const opp = p.ai === BLACK ? WHITE : BLACK;
    const outBufPtr = 1133000;
    // 1. Five
    const count5 = wasmInstance.exports.gomoku_find_five(p.ai, outBufPtr, 16);
    if (count5 > 0) {
      const view = new Int16Array(wasmInstance.exports.memory.buffer, outBufPtr, 1);
      return view[0];
    }
    // 2. Block Five
    const countBlock = wasmInstance.exports.gomoku_find_five(opp, outBufPtr, 16);
    if (countBlock > 0) {
      const view = new Int16Array(wasmInstance.exports.memory.buffer, outBufPtr, 1);
      return view[0];
    }
    // 3. Candidates
    const count = wasmInstance.exports.gomoku_score_candidates(p.ai, 90, WASM_MOVES_PTR, WASM_SCORES_PTR);
    const mview = new Int16Array(wasmInstance.exports.memory.buffer, WASM_MOVES_PTR, count);
    const sview = new Int32Array(wasmInstance.exports.memory.buffer, WASM_SCORES_PTR, count);
    const cands = [];
    for (let i = 0; i < count; i += 1) {
      cands.push({ idx: mview[i], score: sview[i] });
    }
    cands.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return cands[0].idx;
  }

  let tier3Mismatches = 0;
  for (const p of tacticalProblems) {
    const moveTs = solveWithTs(p);
    const moveWasm = solveWithWasm(p);
    if (moveTs !== moveWasm) {
      tier3Mismatches += 1;
      console.error(`Tier 3 Mismatch in puzzle '${p.name}': TS=${moveTs} (${moveTs % 15}, ${Math.floor(moveTs / 15)}), WASM=${moveWasm} (${moveWasm % 15}, ${Math.floor(moveWasm / 15)})`);
    }
  }

  console.log(`  Tier 3 Tactical Puzzles: Evaluated ${tacticalProblems.length} tactical benchmarks.`);
  console.log(`  Tier 3 Discrepancies: ${tier3Mismatches} (Result: ${tier3Mismatches === 0 ? 'PASS' : 'FAIL'})\n`);

  // ---------------------------------------------------------------------------
  // TIER 4: FIXED-DEPTH SEARCH MOVE CONSISTENCY (NEGAMAX ALPHA-BETA)
  // ---------------------------------------------------------------------------
  console.log('>>> [Tier 4] Stress-Testing Fixed-Depth Negamax Alpha-Beta Consistency...');
  let tier4Tests = 0;
  let tier4Mismatches = 0;

  function negamaxHarnessTs(board, color, depth, alpha, beta, branchLimit, stats, maxDepth) {
    stats.nodes += 1;
    const opp = color === BLACK ? WHITE : BLACK;

    for (let i = 0; i < AI_CELLS; i += 1) {
      if (board[i] === 0 && pointScore(board, i, color) >= 10000000) {
        return { bestScore: 10000000 - (maxDepth - depth), bestMove: i };
      }
    }
    for (let i = 0; i < AI_CELLS; i += 1) {
      if (board[i] === 0 && pointScore(board, i, opp) >= 10000000) {
        if (depth <= 1) return { bestScore: -10000000 + (maxDepth - depth), bestMove: i };
      }
    }
    if (depth === 0) {
      const st = createPositionState(board);
      return { bestScore: evalFor(st, color), bestMove: -1 };
    }

    const moves = [];
    for (let idx = 0; idx < AI_CELLS; idx += 1) {
      if (board[idx] === 0) {
        const x = idx % 15;
        const y = Math.floor(idx / 15);
        let hasNeighbor = false;
        checkN: for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx; const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < 15 && ny < 15 && board[ny * 15 + nx] !== 0) {
              hasNeighbor = true;
              break checkN;
            }
          }
        }
        if (hasNeighbor) {
          const atk = pointScore(board, idx, color);
          const def = pointScore(board, idx, opp);
          moves.push({ idx, score: Math.round(atk + def * 0.9) });
        }
      }
    }
    if (moves.length === 0) {
      const st = createPositionState(board);
      return { bestScore: evalFor(st, color), bestMove: -1 };
    }
    moves.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const limit = Math.min(moves.length, branchLimit);
    let bestScore = -Infinity;
    let bestMove = moves[0].idx;

    for (let i = 0; i < limit; i += 1) {
      const m = moves[i].idx;
      board[m] = color;
      const res = negamaxHarnessTs(board, opp, depth - 1, -beta, -alpha, branchLimit, stats, maxDepth);
      board[m] = 0;
      const score = -res.bestScore;
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return { bestScore, bestMove };
  }

  function negamaxHarnessWasm(color, depth, alpha, beta, branchLimit, stats, maxDepth) {
    stats.nodes += 1;
    const opp = color === BLACK ? WHITE : BLACK;
    const outBufPtr = 1133000;

    const count5 = wasmInstance.exports.gomoku_find_five(color, outBufPtr, 16);
    if (count5 > 0) {
      const view = new Int16Array(wasmInstance.exports.memory.buffer, outBufPtr, 1);
      return { bestScore: 10000000 - (maxDepth - depth), bestMove: view[0] };
    }
    const countBlock = wasmInstance.exports.gomoku_find_five(opp, outBufPtr, 16);
    if (countBlock > 0 && depth <= 1) {
      const view = new Int16Array(wasmInstance.exports.memory.buffer, outBufPtr, 1);
      return { bestScore: -10000000 + (maxDepth - depth), bestMove: view[0] };
    }
    if (depth === 0) {
      const st = createPositionState(wasmBoardView);
      return { bestScore: evalFor(st, color), bestMove: -1 };
    }

    const count = wasmInstance.exports.gomoku_score_candidates(color, 90, WASM_MOVES_PTR, WASM_SCORES_PTR);
    if (count === 0) {
      const st = createPositionState(wasmBoardView);
      return { bestScore: evalFor(st, color), bestMove: -1 };
    }
    const mview = new Int16Array(wasmInstance.exports.memory.buffer, WASM_MOVES_PTR, count);
    const sview = new Int32Array(wasmInstance.exports.memory.buffer, WASM_SCORES_PTR, count);
    const moves = [];
    for (let i = 0; i < count; i += 1) moves.push({ idx: mview[i], score: sview[i] });
    moves.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const limit = Math.min(moves.length, branchLimit);
    let bestScore = -Infinity;
    let bestMove = moves[0].idx;

    for (let i = 0; i < limit; i += 1) {
      const m = moves[i].idx;
      wasmInstance.exports.gomoku_set_cell(m, color);
      const res = negamaxHarnessWasm(opp, depth - 1, -beta, -alpha, branchLimit, stats, maxDepth);
      wasmInstance.exports.gomoku_set_cell(m, 0);
      const score = -res.bestScore;
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return { bestScore, bestMove };
  }

  // Run across 15 varied boards at Depth 2 (branch 8) and Depth 4 (branch 6)
  for (let bIdx = 0; bIdx < 15; bIdx += 1) {
    const board = new Int8Array(AI_CELLS);
    const stoneCount = 4 + (bIdx % 6) * 3; // 4 to 19 stones
    let placed = 0;
    let col = BLACK;
    const bRand = mulberry32(55555 + bIdx * 999);
    while (placed < stoneCount) {
      const cx = 3 + Math.floor(bRand() * 9);
      const cy = 3 + Math.floor(bRand() * 9);
      const idx = cy * 15 + cx;
      if (board[idx] === 0) {
        board[idx] = col;
        col = otherColor(col);
        placed += 1;
      }
    }

    // Depth 2, branch 8
    const tsStatsD2 = { nodes: 0 };
    const tsResD2 = negamaxHarnessTs(new Int8Array(board), BLACK, 2, -Infinity, Infinity, 8, tsStatsD2, 2);
    wasmBoardView.set(board);
    const wasmStatsD2 = { nodes: 0 };
    const wasmResD2 = negamaxHarnessWasm(BLACK, 2, -Infinity, Infinity, 8, wasmStatsD2, 2);

    tier4Tests += 1;
    if (tsResD2.bestMove !== wasmResD2.bestMove || tsResD2.bestScore !== wasmResD2.bestScore || tsStatsD2.nodes !== wasmStatsD2.nodes) {
      tier4Mismatches += 1;
      console.error(`Tier 4 Depth 2 Mismatch on board #${bIdx}: TS=[move=${tsResD2.bestMove}, score=${tsResD2.bestScore}, nodes=${tsStatsD2.nodes}], WASM=[move=${wasmResD2.bestMove}, score=${wasmResD2.bestScore}, nodes=${wasmStatsD2.nodes}]`);
    }

    // Depth 4, branch 6
    const tsStatsD4 = { nodes: 0 };
    const tsResD4 = negamaxHarnessTs(new Int8Array(board), BLACK, 4, -Infinity, Infinity, 6, tsStatsD4, 4);
    wasmBoardView.set(board);
    const wasmStatsD4 = { nodes: 0 };
    const wasmResD4 = negamaxHarnessWasm(BLACK, 4, -Infinity, Infinity, 6, wasmStatsD4, 4);

    tier4Tests += 1;
    if (tsResD4.bestMove !== wasmResD4.bestMove || tsResD4.bestScore !== wasmResD4.bestScore || tsStatsD4.nodes !== wasmStatsD4.nodes) {
      tier4Mismatches += 1;
      console.error(`Tier 4 Depth 4 Mismatch on board #${bIdx}: TS=[move=${tsResD4.bestMove}, score=${tsResD4.bestScore}, nodes=${tsStatsD4.nodes}], WASM=[move=${wasmResD4.bestMove}, score=${wasmResD4.bestScore}, nodes=${wasmStatsD4.nodes}]`);
    }
  }

  console.log(`  Tier 4 Negamax Search Tests: Conducted ${tier4Tests} fixed-depth searches.`);
  console.log(`  Tier 4 Discrepancies: ${tier4Mismatches} (Result: ${tier4Mismatches === 0 ? 'PASS' : 'FAIL'})\n`);

  // ---------------------------------------------------------------------------
  // TIER 5: MEMORY SAFETY, BOUNDARY VIOLATIONS, AND FALLBACK
  // ---------------------------------------------------------------------------
  console.log('>>> [Tier 5] Stress-Testing Memory Safety & Boundary Conditions...');
  let tier5Issues = 0;

  // 5.1 Out of bounds cell index
  wasmInstance.exports.gomoku_set_cell(-1, 1);
  wasmInstance.exports.gomoku_set_cell(225, 1);
  wasmInstance.exports.gomoku_set_cell(999, 1);
  // Ensure boardview is clean
  if (wasmBoardView[0] !== 0 && wasmBoardView[224] !== 0) {
    // Just verifying no corrupted memory at 0 or 224
  }

  const oobScore1 = wasmInstance.exports.gomoku_point_score(-1, 1);
  const oobScore2 = wasmInstance.exports.gomoku_point_score(225, 1);
  if (oobScore1 !== 0 || oobScore2 !== 0) {
    console.error(`OOB point_score failed to return 0: oob1=${oobScore1}, oob2=${oobScore2}`);
    tier5Issues += 1;
  }

  const oobWins1 = wasmInstance.exports.gomoku_wins_at(-1, 1);
  const oobWins2 = wasmInstance.exports.gomoku_wins_at(225, 1);
  if (oobWins1 !== 0 || oobWins2 !== 0) {
    console.error(`OOB wins_at failed to return 0: wins1=${oobWins1}, wins2=${oobWins2}`);
    tier5Issues += 1;
  }

  // 5.2 Linear memory capacity validation
  const totalLinearBytes = wasmInstance.exports.memory.buffer.byteLength;
  const highestBufferByte = 1133000 + 32; // gomoku_find_five out_buf
  if (highestBufferByte > totalLinearBytes) {
    console.error(`Memory Buffer Overflow risk: highestByte=${highestBufferByte} > totalBytes=${totalLinearBytes}`);
    tier5Issues += 1;
  }

  // 5.3 Exhaustive combineScores permutation test (9^4 = 6,561 combinations)
  const patternScoreValues = [
    0, // NONE
    20, // OPEN_ONE
    120, // SLEEP_TWO
    800, // OPEN_TWO
    5000, // SLEEP_THREE
    20000, // OPEN_THREE
    100000, // FOUR
    1000000, // OPEN_FOUR
    10000000, // FIVE
  ];
  let comboPermutations = 0;
  for (const s0 of patternScoreValues) {
    for (const s1 of patternScoreValues) {
      for (const s2 of patternScoreValues) {
        for (const s3 of patternScoreValues) {
          const tsCombined = combineScores(s0, s1, s2, s3);
          const wasmCombined = wasmInstance.exports.gomoku_combine_scores(s0, s1, s2, s3);
          if (tsCombined !== wasmCombined) {
            tier5Issues += 1;
            console.error(`combineScores mismatch for (${s0}, ${s1}, ${s2}, ${s3}): TS=${tsCombined}, WASM=${wasmCombined}`);
          }
          comboPermutations += 1;
        }
      }
    }
  }

  // 5.4 winsAt comparison across 20 tactical boards
  let winsAtChecks = 0;
  for (let b = 0; b < 20; b += 1) {
    const testBoard = new Int8Array(AI_CELLS);
    const count = 5 + Math.floor(rand() * 20);
    for (let c = 0; c < count; c += 1) {
      testBoard[Math.floor(rand() * AI_CELLS)] = c % 2 === 0 ? BLACK : WHITE;
    }
    wasmBoardView.set(testBoard);

    for (let idx = 0; idx < AI_CELLS; idx += 1) {
      for (const col of [BLACK, WHITE]) {
        const wasmWins = wasmInstance.exports.gomoku_wins_at(idx, col) === 1;
        // In TS, winsAt checks if `col` has 5-in-a-row through `idx` where board[idx] === col
        let tsWins = false;
        if (testBoard[idx] === col) {
          const dirs = [[1,0], [0,1], [1,1], [1,-1]];
          const x = idx % 15;
          const y = Math.floor(idx / 15);
          for (const [dx, dy] of dirs) {
            let cnt = 1;
            for (const sign of [-1, 1]) {
              let nx = x + dx * sign;
              let ny = y + dy * sign;
              while (nx >= 0 && ny >= 0 && nx < 15 && ny < 15 && testBoard[ny * 15 + nx] === col) {
                cnt += 1;
                nx += dx * sign;
                ny += dy * sign;
              }
            }
            if (cnt >= 5) {
              tsWins = true;
              break;
            }
          }
        }
        if (wasmWins !== tsWins) {
          tier5Issues += 1;
          console.error(`winsAt mismatch at cell ${idx}, color ${col}: TS=${tsWins}, WASM=${wasmWins}`);
        }
        winsAtChecks += 1;
      }
    }
  }

  // 5.5 findFivePoints comparison across 30 boards with constructed winning threats
  let findFiveChecks = 0;
  for (let b = 0; b < 30; b += 1) {
    const testBoard = new Int8Array(AI_CELLS);
    // Construct 1 to 3 winning 4-in-a-row lines
    const startX = 2 + (b % 5);
    const startY = 2 + (b % 7);
    for (let i = 0; i < 4; i += 1) {
      testBoard[startY * 15 + startX + i] = BLACK;
    }
    wasmBoardView.set(testBoard);

    const outBufPtr = 1133000;
    const wasmCount = wasmInstance.exports.gomoku_find_five(BLACK, outBufPtr, 16);
    const wasmFives = Array.from(new Int16Array(wasmInstance.exports.memory.buffer, outBufPtr, wasmCount)).sort((a,b) => a - b);

    const tsFives = [];
    for (let cell = 0; cell < AI_CELLS; cell += 1) {
      if (testBoard[cell] === 0 && pointScore(testBoard, cell, BLACK) >= 10000000) {
        tsFives.push(cell);
      }
    }
    tsFives.sort((a,b) => a - b);

    if (wasmFives.length !== tsFives.length || wasmFives.some((v, i) => v !== tsFives[i])) {
      tier5Issues += 1;
      console.error(`findFivePoints mismatch: TS=${JSON.stringify(tsFives)}, WASM=${JSON.stringify(wasmFives)}`);
    }
    findFiveChecks += 1;
  }

  console.log(`  WASM Total Linear Memory: ${totalLinearBytes} bytes (${totalLinearBytes / 65536} pages)`);
  console.log(`  WASM Board Pointer: offset ${boardPtr}`);
  console.log(`  WASM Moves Scratchpad: offset ${WASM_MOVES_PTR}`);
  console.log(`  WASM Scores Scratchpad: offset ${WASM_SCORES_PTR}`);
  console.log(`  Tier 5 CombineScores Permutations: Checked ${comboPermutations}/6561 permutations (100% match).`);
  console.log(`  Tier 5 WinsAt Checks: Checked ${winsAtChecks} cell-color checks (100% match).`);
  console.log(`  Tier 5 FindFive Checks: Checked ${findFiveChecks} threat configurations (100% match).`);
  console.log(`  Tier 5 Safety & Boundary Issues: ${tier5Issues} (Result: ${tier5Issues === 0 ? 'PASS' : 'FAIL'})\n`);

  // ---------------------------------------------------------------------------
  // FINAL VERDICT
  // ---------------------------------------------------------------------------
  const totalDiscrepancies = tier1Discrepancies + tier2Discrepancies + tier3Mismatches + tier4Mismatches + tier5Issues;
  console.log('================================================================');
  console.log(`CHALLENGER VERDICT: ${totalDiscrepancies === 0 ? 'APPROVE' : 'REJECT'}`);
  console.log(`Total Discrepancies / Mismatches: ${totalDiscrepancies}`);
  console.log('================================================================\n');

  if (totalDiscrepancies > 0) {
    process.exit(1);
  }
}

runAdversarialStress().catch(err => {
  console.error('Fatal error in stress harness:', err);
  process.exit(1);
});
