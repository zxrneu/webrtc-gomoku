/**
 * 局面评估（增量）。
 *
 * 设计：把「全盘棋型分」拆成「每个已占格子的点分之和」。
 * 落子/撤子时只重算落子点 ±4 步内、且落在同一条线上的那些格子在**该方向**上的分值，
 * 其余方向的分值缓存不变——这样每节点的评估开销与棋盘大小无关（架构 §1.3）。
 */

import type { GameState, PlayerColor } from '../index';
import type { AiBoard } from './types';
import {
  AI_CELLS,
  AI_DIRS,
  AI_SIZE,
  asPlayer,
  cellAtIdx,
  fromGameState,
  idxOf,
  oppositeOf,
  setCellAtIdx,
  xOf,
  yOf,
} from './types';
import { combineScores, pointScore, windowScoreAt } from './pattern';
import { DEFENSE_WEIGHT } from './config';
import type { PositionScoring } from './scoring';

/** 终局分值：任何五连都远超普通棋型，保证搜索优先取胜 */
export const MATE_SCORE = 10_000_000;

/** 落子影响域：自身 + 4 方向各 ±1..±4，共 33 个槽位 */
const AFFECT_SPAN = 1 + AI_DIRS.length * 8;

/** 切比雪夫半径 2 的邻居数上限（5×5 去掉自身） */
const NEIGHBOR_SPAN = 24;

/** 影响域表：给定落子点，列出所有需要重算的格子及其受影响方向（-1 表示全部方向） */
const AFFECT = buildAffect();

/** 影响域索引表 */
const AFFECT_IDXS = AFFECT.idxs;

/** 影响域方向表：与 AFFECT_IDXS 平行 */
const AFFECT_DIRS = AFFECT.dirs;

/** 邻域索引表：给定格子，列出切比雪夫 ≤2 的 24 个邻居 */
const NEIGHBOR_IDXS = buildNeighbors();

/** 增量评估状态：棋盘 + 缓存 + 双方总分 + 候选位掩码 + 假设点分缓存 */
export interface PositionState {
  /** 可选的会话私有评分后端，与 cells 同步落子/撤子。 */
  readonly scoring?: PositionScoring;
  /** 内部棋盘 */
  readonly cells: AiBoard;
  /** 每格按 owner 颜色缓存的 4 方向棋型分，长度 225 * 4 */
  readonly dirScore: Int32Array;
  /** 每格组合覆盖后的点分，长度 225 */
  readonly pointScore: Int32Array;
  /** 每格点分归属的颜色，0 表示空点无贡献 */
  readonly pointOwner: Int8Array;
  /** 双方棋型总分，索引为颜色（0 号位不使用） */
  readonly totals: Float64Array;
  /** 每格切比雪夫 ≤2 范围内的棋子数，用于快速筛候选 */
  readonly neighbor: Uint8Array;
  /** 候选位掩码：8 个 uint32 (256 bits)，bit i 置 1 当且仅当 cells[i] === 0 && neighbor[i] > 0 */
  readonly candidateMask: Uint32Array;
  /** 假设点分缓存：每格按 2 种颜色分别缓存，长度 225 * 2 = 450，索引为 (cell << 1) | (color - 1) */
  readonly hypoScore: Int32Array;
  /** 假设点分有效标记：0 = dirty, 1 = valid，长度 450 */
  readonly hypoValid: Uint8Array;
  /** 会话私有临时 scratchpad（多会话并发零污染零重入风险） */
  readonly scratch?: PositionScratchpad;
  /** 已落子数 */
  stoneCount: number;
}

/** 实例级独享临时缓冲区集合，保证多会话/并发零状态交叉污染 */
export interface PositionScratchpad {
  readonly candIdx: Int16Array;
  readonly candScore: Int32Array;
  readonly ownFive: Int16Array;
  readonly oppFive: Int16Array;
  readonly candCells: Int16Array;
  readonly wins: Int16Array;
  readonly candAt: Int16Array;
  readonly candPri: Int32Array;
  readonly candScoreDep: Int32Array;
  readonly seenMask: Uint8Array;
  genTag: number;
  readonly attackAt: Int16Array;
  readonly attackScore: Int32Array;
  readonly defenseAt: Int16Array;
  readonly defenseScore: Int32Array;
}

function buildAffect(): { idxs: Int16Array; dirs: Int8Array } {
  const idxs = new Int16Array(AI_CELLS * AFFECT_SPAN).fill(-1);
  const dirs = new Int8Array(AI_CELLS * AFFECT_SPAN).fill(-1);
  for (let cell = 0; cell < AI_CELLS; cell += 1) {
    const x = xOf(cell);
    const y = yOf(cell);
    const base = cell * AFFECT_SPAN;
    idxs[base] = cell;
    dirs[base] = -1;
    let cursor = 1;
    for (let d = 0; d < AI_DIRS.length; d += 1) {
      const dir = AI_DIRS[d];
      if (dir === undefined) continue;
      for (let k = 1; k <= 4; k += 1) {
        for (const sign of [1, -1] as const) {
          const nx = x + dir[0] * k * sign;
          const ny = y + dir[1] * k * sign;
          if (nx < 0 || ny < 0 || nx >= AI_SIZE || ny >= AI_SIZE) continue;
          idxs[base + cursor] = idxOf(nx, ny);
          dirs[base + cursor] = d;
          cursor += 1;
        }
      }
    }
  }
  return { idxs, dirs };
}

function buildNeighbors(): Int16Array {
  const out = new Int16Array(AI_CELLS * NEIGHBOR_SPAN).fill(-1);
  for (let cell = 0; cell < AI_CELLS; cell += 1) {
    const x = xOf(cell);
    const y = yOf(cell);
    const base = cell * NEIGHBOR_SPAN;
    let cursor = 0;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= AI_SIZE || ny >= AI_SIZE) continue;
        out[base + cursor] = idxOf(nx, ny);
        cursor += 1;
      }
    }
  }
  return out;
}

/** 从 4 个方向缓存分算出组合覆盖后的点分 */
function pointScoreFromCache(st: PositionState, cell: number): number {
  const base = cell * 4;
  return combineScores(
    st.dirScore[base] ?? 0,
    st.dirScore[base + 1] ?? 0,
    st.dirScore[base + 2] ?? 0,
    st.dirScore[base + 3] ?? 0,
  );
}

/** 重算某格全部 4 个方向并写回缓存 */
function refreshAllDirections(st: PositionState, cell: number, color: PlayerColor): void {
  const base = cell * 4;
  for (let d = 0; d < 4; d += 1) {
    st.dirScore[base + d] = st.scoring ? st.scoring.windowScore(cell, d, color) : windowScoreAt(st.cells, cell, d, color);
  }
}

/** 把某格的点分变化同步进双方总分 */
function syncPointScore(st: PositionState, cell: number): void {
  const owner = cellAtIdx(st.cells, cell);
  const oldScore = st.pointScore[cell] ?? 0;
  const oldOwner = st.pointOwner[cell] ?? 0;
  const newScore = owner === 0 ? 0 : pointScoreFromCache(st, cell);
  if (newScore === oldScore && owner === oldOwner) return;
  st.totals[oldOwner] = (st.totals[oldOwner] ?? 0) - oldScore;
  st.totals[owner] = (st.totals[owner] ?? 0) + newScore;
  st.pointScore[cell] = newScore;
  st.pointOwner[cell] = owner;
}

/** 重算落子点影响域内所有格子的分值，并脏化假设点分缓存 */
function refreshAround(st: PositionState, cell: number): void {
  const base = cell * AFFECT_SPAN;
  for (let slot = 0; slot < AFFECT_SPAN; slot += 1) {
    const p = AFFECT_IDXS[base + slot] ?? -1;
    if (p < 0) break;

    // 脏化受影响格子的假设点分缓存
    const hBase = p << 1;
    st.hypoValid[hBase] = 0;
    st.hypoValid[hBase + 1] = 0;

    const owner = cellAtIdx(st.cells, p);
    if (owner === 0) {
      syncPointScore(st, p);
      continue;
    }
    const d = AFFECT_DIRS[base + slot] ?? -1;
    if (d < 0) {
      refreshAllDirections(st, p, asPlayer(owner));
    } else {
      st.dirScore[p * 4 + d] = st.scoring ? st.scoring.windowScore(p, d, owner) : windowScoreAt(st.cells, p, d, asPlayer(owner));
    }
    syncPointScore(st, p);
  }
}

/** 维护切比雪夫 ≤2 的邻居计数与 candidateMask */
function bumpNeighbor(st: PositionState, cell: number, delta: number): void {
  const base = cell * NEIGHBOR_SPAN;
  for (let k = 0; k < NEIGHBOR_SPAN; k += 1) {
    const n = NEIGHBOR_IDXS[base + k] ?? -1;
    if (n < 0) break;
    const count = Math.max(0, (st.neighbor[n] ?? 0) + delta);
    st.neighbor[n] = count;
    if (cellAtIdx(st.cells, n) === 0) {
      const word = n >>> 5;
      const bit = 1 << (n & 31);
      if (count > 0) {
        st.candidateMask[word]! |= bit;
      } else {
        st.candidateMask[word]! &= ~bit;
      }
    }
  }
}

/** 由内部棋盘构建完整评估状态（唯一一次全盘扫描） */
export function createPositionState(board: AiBoard, scoring?: PositionScoring): PositionState {
  const cells = new Int8Array(AI_CELLS);
  for (let cell = 0; cell < AI_CELLS; cell += 1) {
    setCellAtIdx(cells, cell, cellAtIdx(board, cell));
  }
  const st: PositionState = {
    scoring,
    cells,
    dirScore: new Int32Array(AI_CELLS * 4),
    pointScore: new Int32Array(AI_CELLS),
    pointOwner: new Int8Array(AI_CELLS),
    totals: new Float64Array(3),
    neighbor: new Uint8Array(AI_CELLS),
    candidateMask: new Uint32Array(8),
    hypoScore: new Int32Array(AI_CELLS * 2),
    hypoValid: new Uint8Array(AI_CELLS * 2),
    scratch: {
      candIdx: new Int16Array(AI_CELLS),
      candScore: new Int32Array(AI_CELLS),
      ownFive: new Int16Array(16),
      oppFive: new Int16Array(16),
      candCells: new Int16Array(AI_CELLS),
      wins: new Int16Array(16),
      candAt: new Int16Array(AI_CELLS),
      candPri: new Int32Array(AI_CELLS),
      candScoreDep: new Int32Array(AI_CELLS),
      seenMask: new Uint8Array(AI_CELLS),
      genTag: 1,
      attackAt: new Int16Array(AI_CELLS),
      attackScore: new Int32Array(AI_CELLS),
      defenseAt: new Int16Array(AI_CELLS),
      defenseScore: new Int32Array(AI_CELLS),
    },
    stoneCount: 0,
  };
  scoring?.setBoard(cells);
  for (let cell = 0; cell < AI_CELLS; cell += 1) {
    const owner = cellAtIdx(cells, cell);
    if (owner === 0) continue;
    st.stoneCount += 1;
    refreshAllDirections(st, cell, asPlayer(owner));
    syncPointScore(st, cell);
    bumpNeighbor(st, cell, 1);
  }
  return st;
}

/** 落子（原地修改；调用方必须成对调用 removeStone） */
export function placeStone(st: PositionState, cell: number, color: PlayerColor): void {
  setCellAtIdx(st.cells, cell, color);
  st.scoring?.setCell(cell, color);
  st.candidateMask[cell >>> 5]! &= ~(1 << (cell & 31));
  st.stoneCount += 1;
  bumpNeighbor(st, cell, 1);
  refreshAround(st, cell);
}

/** 撤子（原地修改） */
export function removeStone(st: PositionState, cell: number): void {
  setCellAtIdx(st.cells, cell, 0);
  st.scoring?.setCell(cell, 0);
  if ((st.neighbor[cell] ?? 0) > 0) {
    st.candidateMask[cell >>> 5]! |= (1 << (cell & 31));
  }
  st.stoneCount -= 1;
  bumpNeighbor(st, cell, -1);
  refreshAround(st, cell);
}

/** 某格当前的点分（已按 owner 计算） */
export function pointScoreOf(st: PositionState, cell: number): number {
  return st.pointScore[cell] ?? 0;
}

/**
 * 获取某格的假设点分（带 O(1) 增量缓存）。
 * 若该点在受影响域外，直接返回缓存；否则即时计算并写入缓存。
 */
export function getHypoPointScore(st: PositionState, cell: number, color: PlayerColor): number {
  const key = (cell << 1) | (color - 1);
  if (st.hypoValid[key] === 1) {
    return st.hypoScore[key] ?? 0;
  }
  const score = st.scoring ? st.scoring.pointScore(cell, color) : pointScore(st.cells, cell, color);
  st.hypoScore[key] = score;
  st.hypoValid[key] = 1;
  return score;
}

/** 局面分：me 视角，正数=me 优；防守权重 1.1 略偏堵 */
export function evalFor(st: PositionState, me: PlayerColor): number {
  const own = st.totals[me] ?? 0;
  const opp = st.totals[oppositeOf(me)] ?? 0;
  return Math.round(own - opp * DEFENSE_WEIGHT);
}

/** 对外局面分（供 P2 评估条 / 提示复用），me 视角，正数=me 优 */
export function evaluateBoard(g: GameState, me: PlayerColor): number {
  return evalFor(createPositionState(fromGameState(g)), me);
}
