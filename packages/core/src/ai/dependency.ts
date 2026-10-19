/** 威胁描述与依赖关系；只提供搜索提示，不承担胜负证明。 */
import type { AiBoard, PlayerColor } from './types';
import { AI_CELLS, AI_DIRS, AI_SIZE, idxOf, oppositeOf, xOf, yOf } from './types';
import { winsAt } from './proofRules';
import { PATTERN_SCORES, patternAt, pointScore } from './pattern';
import type { PositionScratchpad } from './evaluate';

export interface Threat {
  readonly kind: 'five' | 'four' | 'three';
  readonly gain: number;
  readonly cost: readonly number[];
  readonly rest: readonly number[];
  readonly stones: readonly number[];
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < AI_SIZE && y >= 0 && y < AI_SIZE;
}

/** Deduplication generation tag buffer (225 bytes) */
const scratchSeenMask = new Uint8Array(AI_CELLS);
let genTag = 1;

/**
 * Returns the next monotonic tag in [1, 255].
 * When genTag reaches 255, scratchSeenMask is wiped with .fill(0)
 * and genTag resets to 1, guaranteeing scratchSeenMask never contains 1.
 */
function nextGenTag(): number {
  if (genTag >= 255) {
    scratchSeenMask.fill(0);
    genTag = 1;
  }
  return genTag++;
}

/** Preallocated scratch buffers for analyzeThreats */
const scratchFourWins = new Int16Array(16);
const scratchFourStones = new Int16Array(16);
const scratchThreeMakers = new Int16Array(16);
const scratchThreeRest = new Int16Array(32);
const scratchThreeStones = new Int16Array(16);
const scratchCompletionWins = new Int16Array(16);

/** Preallocated scratch buffers for orderAttackCandidates */
const scratchCandCells = new Int16Array(AI_CELLS);
const scratchWins = new Int16Array(16);
const scratchCandAt = new Int16Array(AI_CELLS);
const scratchCandPri = new Int32Array(AI_CELLS);
const scratchCandScore = new Int32Array(AI_CELLS);

/** 内部视图：有效坐标之后以 -1 填充；下一次分析会覆盖内容。 */
export interface BufferedThreat {
  kind: Threat['kind'];
  gain: number;
  readonly cost: Int16Array;
  readonly rest: Int16Array;
  readonly stones: Int16Array;
}
export interface ThreatBuffer {
  readonly entries: readonly BufferedThreat[];
  count: number;
}
export function createThreatBuffer(): ThreatBuffer {
  return {
    entries: Array.from({ length: 4 }, () => ({
      kind: 'three' as const, gain: -1,
      cost: new Int16Array(16).fill(-1), rest: new Int16Array(32).fill(-1),
      stones: new Int16Array(16).fill(-1),
    })),
    count: 0,
  };
}
const candidateThreats = createThreatBuffer();

function recordThreat(out: ThreatBuffer, kind: Threat['kind'], gain: number): BufferedThreat {
  const entry = out.entries[out.count++]!;
  entry.kind = kind;
  entry.gain = gain;
  entry.cost.fill(-1);
  entry.rest.fill(-1);
  entry.stones.fill(-1);
  return entry;
}
function copyPoints(dest: Int16Array, src: Int16Array, count: number): void {
  for (let i = 0; i < count; i += 1) dest[i] = src[i]!;
}
function materialize(points: Int16Array): number[] {
  let count = 0;
  while (count < points.length && points[count]! >= 0) count += 1;
  return toArray(points, count);
}

/** In-place insertion sort for small Int16Array slices (ascending) */
function sortInt16(arr: Int16Array, len: number): void {
  for (let i = 1; i < len; i += 1) {
    const key = arr[i]!;
    let j = i - 1;
    while (j >= 0 && arr[j]! > key) {
      arr[j + 1] = arr[j]!;
      j -= 1;
    }
    arr[j + 1] = key;
  }
}

/** Fast transfer from sorted typed slice to compact JavaScript Array */
function toArray(buf: Int16Array, len: number): number[] {
  if (len === 0) return [];
  const out = new Array<number>(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = buf[i]!;
  }
  return out;
}

export function analyzeThreats(board: AiBoard, at: number, color: PlayerColor): Threat[] {
  const count = analyzeThreatsInto(board, at, color, candidateThreats);
  const threats = new Array<Threat>(count);
  for (let i = 0; i < count; i += 1) {
    const entry = candidateThreats.entries[i]!;
    threats[i] = { kind: entry.kind, gain: entry.gain, cost: materialize(entry.cost),
      rest: materialize(entry.rest), stones: materialize(entry.stones) };
  }
  return threats;
}

/** 零分配分析；输出只在本次调用至下一次复用之间有效，输入棋盘始终恢复。 */
export function analyzeThreatsInto(board: AiBoard, at: number, color: PlayerColor, out: ThreatBuffer): number {
  out.count = 0;
  if (!board || board.length !== AI_CELLS) return 0;
  if (at < 0 || at >= AI_CELLS || board[at] !== 0) return 0;
  if (color !== 1 && color !== 2) return 0;
  const x = xOf(at);
  const y = yOf(at);

  board[at] = color;
  try {
    for (let d = 0; d < AI_DIRS.length; d += 1) {
      const [dx, dy] = AI_DIRS[d]!;
      const pat = patternAt(board, at, d, color);
      if (pat !== 'FIVE' && pat !== 'OPEN_FOUR' && pat !== 'FOUR' && pat !== 'OPEN_THREE') {
        continue;
      }

      // 1. 检查是否直接成五
      if (pat === 'FIVE' && winsAt(board, at, color)) {
        let stonesCount = 0;
        for (let sign = -1; sign <= 1; sign += 2) {
          let step = 1;
          while (true) {
            const nx = x + dx * sign * step;
            const ny = y + dy * sign * step;
            if (!inBounds(nx, ny)) break;
            const idx = idxOf(nx, ny);
            if (board[idx] !== color) break;
            scratchFourStones[stonesCount++] = idx;
            step += 1;
          }
        }
        sortInt16(scratchFourStones, stonesCount);
        const entry = recordThreat(out, 'five', at);
        copyPoints(entry.stones, scratchFourStones, stonesCount);
        continue;
      }

      // 2. 检查成四威胁（在同一线路上再下一子能否成五）
      if (pat === 'OPEN_FOUR' || pat === 'FOUR') {
        let fourWinsCount = 0;
        let fourStonesCount = 0;
        const stoneTag = nextGenTag();

        for (let k = -4; k <= 4; k += 1) {
          if (k === 0) continue;
          const nx = x + dx * k;
          const ny = y + dy * k;
          if (!inBounds(nx, ny)) continue;
          const pos = idxOf(nx, ny);
          if (board[pos] === 0) {
            board[pos] = color;
            if (winsAt(board, pos, color) && winsAt(board, at, color)) {
              scratchFourWins[fourWinsCount++] = pos;
              // 收集参与构成连线的同色子
              for (let step = -4; step <= 4; step += 1) {
                const sx = nx + dx * step;
                const sy = ny + dy * step;
                if (inBounds(sx, sy)) {
                  const sIdx = idxOf(sx, sy);
                  if (sIdx !== at && sIdx !== pos && board[sIdx] === color) {
                    if (scratchSeenMask[sIdx] !== stoneTag) {
                      scratchSeenMask[sIdx] = stoneTag;
                      scratchFourStones[fourStonesCount++] = sIdx;
                    }
                  }
                }
              }
            }
            board[pos] = 0;
          }
        }

        if (fourWinsCount > 0) {
          sortInt16(scratchFourWins, fourWinsCount);
          sortInt16(scratchFourStones, fourStonesCount);
          const entry = recordThreat(out, 'four', at);
          copyPoints(entry.cost, scratchFourWins, fourWinsCount);
          copyPoints(entry.rest, scratchFourWins, fourWinsCount);
          copyPoints(entry.stones, scratchFourStones, fourStonesCount);
          continue;
        }
      }

      // 3. 检查成三威胁（在同一线路上再下一子能否形成活四）
      if (pat === 'OPEN_THREE') {
        let threeMakersCount = 0;
        let threeRestCount = 0;
        let threeStonesCount = 0;
        const restTag = nextGenTag();
        const stoneTag = nextGenTag();

        for (let k = -4; k <= 4; k += 1) {
          if (k === 0) continue;
          const nx = x + dx * k;
          const ny = y + dy * k;
          if (!inBounds(nx, ny)) continue;
          const pos = idxOf(nx, ny);
          if (board[pos] === 0) {
            board[pos] = color;
            // 检查落子 pos 后，该方向上是否能形成活四（>= 2 个成五点）
            let completionWinsCount = 0;
            for (let m = -4; m <= 4; m += 1) {
              if (m === 0 || m === k) continue;
              const mx = x + dx * m;
              const my = y + dy * m;
              if (!inBounds(mx, my)) continue;
              const mPos = idxOf(mx, my);
              if (board[mPos] === 0) {
                board[mPos] = color;
                if (winsAt(board, mPos, color) && winsAt(board, at, color) && winsAt(board, pos, color)) {
                  scratchCompletionWins[completionWinsCount++] = mPos;
                }
                board[mPos] = 0;
              }
            }
            if (completionWinsCount >= 2) {
              scratchThreeMakers[threeMakersCount++] = pos;
              if (scratchSeenMask[pos] !== restTag) {
                scratchSeenMask[pos] = restTag;
                scratchThreeRest[threeRestCount++] = pos;
              }
              for (let w = 0; w < completionWinsCount; w += 1) {
                const winPos = scratchCompletionWins[w]!;
                if (scratchSeenMask[winPos] !== restTag) {
                  scratchSeenMask[winPos] = restTag;
                  scratchThreeRest[threeRestCount++] = winPos;
                }
              }
              // 收集现有己方棋子
              for (let step = -4; step <= 4; step += 1) {
                const sx = x + dx * step;
                const sy = y + dy * step;
                if (inBounds(sx, sy)) {
                  const sIdx = idxOf(sx, sy);
                  if (sIdx !== at && sIdx !== pos && board[sIdx] === color) {
                    if (scratchSeenMask[sIdx] !== stoneTag) {
                      scratchSeenMask[sIdx] = stoneTag;
                      scratchThreeStones[threeStonesCount++] = sIdx;
                    }
                  }
                }
              }
            }
            board[pos] = 0;
          }
        }

        if (threeMakersCount > 0) {
          sortInt16(scratchThreeMakers, threeMakersCount);
          sortInt16(scratchThreeRest, threeRestCount);
          sortInt16(scratchThreeStones, threeStonesCount);
          const entry = recordThreat(out, 'three', at);
          copyPoints(entry.cost, scratchThreeMakers, threeMakersCount);
          copyPoints(entry.rest, scratchThreeRest, threeRestCount);
          copyPoints(entry.stones, scratchThreeStones, threeStonesCount);
        }
      }
    }
  } finally {
    board[at] = 0;
  }

  return out.count;
}

export function threatDependsOn(parent: Threat, child: Threat | BufferedThreat): boolean {
  if (!child.stones.includes(parent.gain)) return false;
  if (!parent.cost.includes(child.gain)) return false;
  for (let i = 0; i < child.stones.length; i += 1) {
    const stone = child.stones[i]!;
    if (stone >= 0 && parent.cost.includes(stone)) return false;
  }
  return true;
}

const NEIGHBOR_SPAN = 24;
const NEIGHBOR_TABLE = buildNeighborTable();
const neighborMask = new Uint8Array(AI_CELLS);

function buildNeighborTable(): Int16Array {
  const table = new Int16Array(AI_CELLS * NEIGHBOR_SPAN);
  for (let idx = 0; idx < AI_CELLS; idx += 1) {
    const x = xOf(idx);
    const y = yOf(idx);
    const base = idx * NEIGHBOR_SPAN;
    let cursor = 0;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < AI_SIZE && ny >= 0 && ny < AI_SIZE) {
          table[base + cursor] = idxOf(nx, ny);
          cursor += 1;
        }
      }
    }
    while (cursor < NEIGHBOR_SPAN) {
      table[base + cursor] = -1;
      cursor += 1;
    }
  }
  return table;
}

/** Fallback: 收集盘上所有棋子切比雪夫 <= 2 范围内的空格写入 buffer（无 PositionState 时使用） */
function collectNeighborEmptyCellsInto(board: AiBoard, outBuf: Int16Array): number {
  neighborMask.fill(0);
  let hasStones = false;
  for (let i = 0; i < AI_CELLS; i += 1) {
    if (board[i] === 0) continue;
    hasStones = true;
    const base = i * NEIGHBOR_SPAN;
    for (let k = 0; k < NEIGHBOR_SPAN; k += 1) {
      const nIdx = NEIGHBOR_TABLE[base + k]!;
      if (nIdx < 0) break;
      neighborMask[nIdx] = 1;
    }
  }
  if (!hasStones) return 0;

  let count = 0;
  for (let i = 0; i < AI_CELLS; i += 1) {
    if (board[i] === 0 && neighborMask[i] === 1) {
      outBuf[count++] = i;
    }
  }
  return count;
}

/** 零分配收集直接成五点 */
function findWinningPointsInto(
  board: AiBoard,
  color: PlayerColor,
  candidateCells: Int16Array,
  candidateCount: number,
  outBuf: Int16Array,
): number {
  let count = 0;
  for (let i = 0; i < candidateCount; i += 1) {
    const at = candidateCells[i]!;
    if (board[at] !== 0) continue;
    board[at] = color;
    if (winsAt(board, at, color)) {
      outBuf[count++] = at;
    }
    board[at] = 0;
  }
  return count;
}

export function orderAttackCandidates(
  boardOrState: AiBoard | { cells: AiBoard; neighbor: Uint8Array | Int8Array; candidateMask?: Uint32Array; scratch?: PositionScratchpad },
  color: PlayerColor,
  mode: 'fours' | 'threats' | 'complete',
  parentThreat?: Threat,
): number[] {
  const isState = typeof boardOrState === 'object' && boardOrState !== null && 'cells' in boardOrState && 'neighbor' in boardOrState;
  const board: AiBoard = isState ? boardOrState.cells : (boardOrState as AiBoard);
  const scratch = isState && 'scratch' in boardOrState ? boardOrState.scratch : undefined;

  const candCells = scratch?.candCells ?? scratchCandCells;
  const wins = scratch?.wins ?? scratchWins;
  const candAt = scratch?.candAt ?? scratchCandAt;
  const candPri = scratch?.candPri ?? scratchCandPri;
  const candScore = scratch?.candScoreDep ?? scratchCandScore;

  let candCellCount = 0;
  if (isState) {
    // 直接读取邻域空格，完全避免两次全盘扫描与 NEIGHBOR_TABLE 重复查表
    const { cells, neighbor, candidateMask } = boardOrState;
    if (candidateMask) {
      for (let w = 0; w < 8; w += 1) {
        let word = candidateMask[w]!;
        while (word !== 0) {
          const lsb = word & -word;
          const bit = 31 - Math.clz32(lsb);
          const cell = (w << 5) | bit;
          if (cell < AI_CELLS) {
            candCells[candCellCount++] = cell;
          }
          word ^= lsb;
        }
      }
    } else {
      for (let i = 0; i < AI_CELLS; i += 1) {
        if (cells[i] === 0 && (neighbor[i] ?? 0) > 0) {
          candCells[candCellCount++] = i;
        }
      }
    }
  } else {
    candCellCount = collectNeighborEmptyCellsInto(board, candCells);
  }

  if (candCellCount === 0) {
    // 空盘 fallback
    return board[idxOf(7, 7)] === 0 ? [idxOf(7, 7)] : [];
  }

  // 1. 己方直接成五（只在邻域空格内检索）
  const winCount = findWinningPointsInto(board, color, candCells, candCellCount, wins);
  if (winCount > 0) {
    sortInt16(wins, winCount);
    return toArray(wins, winCount);
  }

  // 2. 对手立即成五：双五则无法防守，单五必须堵
  const opponent = oppositeOf(color);
  const oppWinCount = findWinningPointsInto(board, opponent, candCells, candCellCount, wins);
  if (oppWinCount >= 2) return [];
  if (oppWinCount === 1) return [wins[0]!];

  // 3. 收集候选进攻点入静态平行 typed buffers
  const threshold = mode === 'fours' ? PATTERN_SCORES.FOUR : PATTERN_SCORES.OPEN_THREE;
  let candCount = 0;

  for (let i = 0; i < candCellCount; i += 1) {
    const at = candCells[i]!;
    const score = pointScore(board, at, color);
    if (mode !== 'complete' && score < threshold) continue;

    const threatCount = analyzeThreatsInto(board, at, color, candidateThreats);
    let five = false;
    let four = false;
    let three = false;
    let dependent = false;
    for (let j = 0; j < threatCount; j += 1) {
      const threat = candidateThreats.entries[j]!;
      if (threat.kind === 'five') five = true;
      if (threat.kind === 'four') four = true;
      if (threat.kind === 'three') three = true;
      if (parentThreat && threatDependsOn(parentThreat, threat)) dependent = true;
    }
    let priority = 10000;
    if (five) priority = 50000;
    else if (four && threatCount >= 2) priority = 40000;
    else if (four) priority = dependent ? 35000 : 30000;
    else if (three) priority = parentThreat && (parentThreat.cost.includes(at) || dependent) ? 25000 : 20000;

    candAt[candCount] = at;
    candPri[candCount] = priority;
    candScore[candCount] = score;
    candCount += 1;
  }

  // 4. 原地三键插入排序：priority DESC, score DESC, at ASC
  for (let i = 1; i < candCount; i += 1) {
    const curAt = candAt[i]!;
    const curPri = candPri[i]!;
    const curScore = candScore[i]!;

    let j = i - 1;
    while (j >= 0) {
      const prevPri = candPri[j]!;
      const prevScore = candScore[j]!;
      const prevAt = candAt[j]!;

      // cur 具有更高优先权则 prev 向后平移
      const higher =
        curPri > prevPri ||
        (curPri === prevPri && (curScore > prevScore || (curScore === prevScore && curAt < prevAt)));

      if (higher) {
        candAt[j + 1] = prevAt;
        candPri[j + 1] = prevPri;
        candScore[j + 1] = prevScore;
        j -= 1;
      } else {
        break;
      }
    }
    candAt[j + 1] = curAt;
    candPri[j + 1] = curPri;
    candScore[j + 1] = curScore;
  }

  // 5. 单次分配输出结果数组
  const result = new Array<number>(candCount);
  for (let i = 0; i < candCount; i += 1) {
    result[i] = candAt[i]!;
  }
  return result;
}
