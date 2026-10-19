/**
 * 走法生成与分支裁剪。
 *
 * 三层知识（与搜索深度无关，保证「不送棋」底线）：
 * 1. 空盘直接走开局点；
 * 2. 己方有成五点 -> 候选长度 1（立刻赢）；
 * 3. 对方有成五点 -> 候选收缩为堵点。
 * 其余情况按 `attack + defense * 0.9` 排序，tie-break 固定按 idx 升序保证确定性。
 */

import type { PlayerColor } from './types';
import { AI_CELLS, CENTER_IDX, oppositeOf } from './types';
import { PATTERN_SCORES } from './pattern';
import { ORDER_DEFENSE_WEIGHT } from './config';
import { getHypoPointScore, type PositionState } from './evaluate';

/** 候选点：落子后的一手棋及排序分 */
export interface Candidate {
  /** 线性索引 */
  readonly idx: number;
  /** 排序分（attack + defense * 权重） */
  readonly order: number;
}

/** 静态预分配临时缓冲（单线程零分配） */
const scratchCandIdx = new Int16Array(AI_CELLS);
const scratchCandScore = new Int32Array(AI_CELLS);
const scratchOwnFive = new Int16Array(16);
const scratchOppFive = new Int16Array(16);
const scratchPublicBuf = new Int16Array(AI_CELLS);

/** 单层搜索走法缓冲区槽位上限（对齐 SearchSession.PLY_STRIDE） */
export const MAX_PLY_BRANCHES = 16;

/** 收集邻域（切比雪夫 ≤2）内的全部空点，按 idx 升序（基于 candidateMask 高速位运算） */
export function collectCandidates(st: PositionState): number[] {
  const out: number[] = [];
  const mask = st.candidateMask;
  for (let w = 0; w < 8; w += 1) {
    let word = mask[w] ?? 0;
    while (word !== 0) {
      const lsb = word & -word;
      const bit = 31 - Math.clz32(lsb);
      const cell = (w << 5) | bit;
      word ^= lsb;
      if (cell < AI_CELLS) {
        out.push(cell);
      }
    }
  }
  return out;
}

/**
 * 零分配走法生成并直接写入目标缓冲。
 *
 * 排序与确定性保证：
 * 1. 空盘返回 1 步 (CENTER_IDX)。
 * 2. 己方成五返回 1 步 (唯一必杀点)。
 * 3. 对方成五返回堵点，截取至 safeLimit (≤ MAX_PLY_BRANCHES)。
 * 4. 常规走法采用静态 typed scratchpad 原地插入排序，严格保持 (b.order - a.order) || (a.idx - b.idx)。
 *
 * @param st 当前局面
 * @param color 行棋方
 * @param branchLimit 分支上限（自动 clamp 到 [1, MAX_PLY_BRANCHES]，防止写穿分层缓冲区）
 * @param outBuf 目标 Int16Array 缓冲
 * @param offset 目标写入起始偏移量
 * @returns 写入的有效走法数量
 */
export function generateMovesInto(
  st: PositionState,
  color: PlayerColor,
  branchLimit: number,
  outBuf: Int16Array,
  offset: number,
): number {
  if (st.stoneCount === 0) {
    outBuf[offset] = CENTER_IDX;
    return 1;
  }

  const safeLimit = Math.min(Math.max(1, branchLimit), MAX_PLY_BRANCHES);
  const opp = oppositeOf(color);
  let candCount = 0;
  let ownFiveCount = 0;
  let oppFiveCount = 0;

  const candIdx = st.scratch?.candIdx ?? scratchCandIdx;
  const candScore = st.scratch?.candScore ?? scratchCandScore;
  const ownFive = st.scratch?.ownFive ?? scratchOwnFive;
  const oppFive = st.scratch?.oppFive ?? scratchOppFive;

  const mask = st.candidateMask;
  for (let w = 0; w < 8; w += 1) {
    let word = mask[w] ?? 0;
    while (word !== 0) {
      const lsb = word & -word;
      const bit = 31 - Math.clz32(lsb);
      const cell = (w << 5) | bit;
      word ^= lsb;

      if (cell >= AI_CELLS) continue;

      const attack = getHypoPointScore(st, cell, color);
      const defense = getHypoPointScore(st, cell, opp);

      if (attack >= PATTERN_SCORES.FIVE) {
        if (ownFiveCount < 16) {
          ownFive[ownFiveCount] = cell;
          ownFiveCount += 1;
        }
      }
      if (defense >= PATTERN_SCORES.FIVE) {
        if (oppFiveCount < 16) {
          oppFive[oppFiveCount] = cell;
          oppFiveCount += 1;
        }
      }

      candIdx[candCount] = cell;
      candScore[candCount] = Math.round(attack + defense * ORDER_DEFENSE_WEIGHT);
      candCount += 1;
    }
  }

  // 1. 己方成五：唯一正解，与深度无关
  if (ownFiveCount > 0) {
    outBuf[offset] = ownFive[0] ?? CENTER_IDX;
    return 1;
  }

  // 2. 对方成五：必须堵，候选全收缩为堵点（截取至 safeLimit，防越界）
  if (oppFiveCount > 0) {
    const count = Math.min(safeLimit, oppFiveCount);
    for (let i = 0; i < count; i += 1) {
      outBuf[offset + i] = oppFive[i] ?? CENTER_IDX;
    }
    return count;
  }

  // 3. 常规候选排序：原地插入排序，确保 (b.order - a.order) || (a.idx - b.idx) 严格确定性
  for (let i = 1; i < candCount; i += 1) {
    const curIdx = candIdx[i]!;
    const curScore = candScore[i]!;
    let j = i - 1;
    while (j >= 0) {
      const prevScore = candScore[j]!;
      const prevIdx = candIdx[j]!;
      if (curScore > prevScore || (curScore === prevScore && curIdx < prevIdx)) {
        candIdx[j + 1] = prevIdx;
        candScore[j + 1] = prevScore;
        j -= 1;
      } else {
        break;
      }
    }
    candIdx[j + 1] = curIdx;
    candScore[j + 1] = curScore;
  }

  const count = Math.min(safeLimit, candCount);
  for (let i = 0; i < count; i += 1) {
    outBuf[offset + i] = candIdx[i]!;
  }
  return count;
}

/**
 * 生成候选走法（已排序、已裁剪）。对外兼容包装。
 * @param branchLimit 本层分支上限
 */
export function generateMoves(st: PositionState, color: PlayerColor, branchLimit: number): number[] {
  const count = generateMovesInto(st, color, branchLimit, scratchPublicBuf, 0);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = scratchPublicBuf[i]!;
  }
  return out;
}

/** 收集所有「某方落子即成五」的点（VCF 与强制应手判定复用） */
export function findFivePoints(st: PositionState, color: PlayerColor): number[] {
  const out: number[] = [];
  const mask = st.candidateMask;
  for (let w = 0; w < 8; w += 1) {
    let word = mask[w] ?? 0;
    while (word !== 0) {
      const lsb = word & -word;
      const bit = 31 - Math.clz32(lsb);
      const cell = (w << 5) | bit;
      word ^= lsb;
      if (cell < AI_CELLS && getHypoPointScore(st, cell, color) >= PATTERN_SCORES.FIVE) {
        out.push(cell);
      }
    }
  }
  return out;
}
