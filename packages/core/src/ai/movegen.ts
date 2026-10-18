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
import { AI_CELLS, CENTER_IDX, cellAtIdx, oppositeOf } from './types';
import { PATTERN_SCORES, pointScore } from './pattern';
import { ORDER_DEFENSE_WEIGHT } from './config';
import type { PositionState } from './evaluate';

/** 候选点：落子后的一手棋及排序分 */
export interface Candidate {
  /** 线性索引 */
  readonly idx: number;
  /** 排序分（attack + defense * 权重） */
  readonly order: number;
}

/** 收集邻域（切比雪夫 ≤2）内的全部空点，按 idx 升序 */
export function collectCandidates(st: PositionState): number[] {
  const out: number[] = [];
  for (let cell = 0; cell < AI_CELLS; cell += 1) {
    if (cellAtIdx(st.cells, cell) !== 0) continue;
    if ((st.neighbor[cell] ?? 0) === 0) continue;
    out.push(cell);
  }
  return out;
}

/**
 * 生成候选走法（已排序、已裁剪）。
 * @param branchLimit 本层分支上限
 */
export function generateMoves(st: PositionState, color: PlayerColor, branchLimit: number): number[] {
  if (st.stoneCount === 0) return [CENTER_IDX];
  const opp = oppositeOf(color);
  const ownFive: number[] = [];
  const oppFive: number[] = [];
  const scored: Candidate[] = [];
  for (const cell of collectCandidates(st)) {
    const attack = pointScore(st.cells, cell, color);
    const defense = pointScore(st.cells, cell, opp);
    if (attack >= PATTERN_SCORES.FIVE) ownFive.push(cell);
    if (defense >= PATTERN_SCORES.FIVE) oppFive.push(cell);
    scored.push({ idx: cell, order: attack + defense * ORDER_DEFENSE_WEIGHT });
  }
  // 己方成五：唯一正解，与深度无关
  if (ownFive.length > 0) return [ownFive[0] ?? CENTER_IDX];
  // 对方成五：必须堵，候选收缩为堵点
  if (oppFive.length > 0) {
    oppFive.sort((a, b) => a - b);
    return oppFive.slice(0, Math.max(1, branchLimit));
  }
  scored.sort((a, b) => (b.order - a.order) || (a.idx - b.idx));
  const limit = Math.min(Math.max(1, branchLimit), scored.length);
  const out: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    const item = scored[i];
    if (item !== undefined) out.push(item.idx);
  }
  return out;
}

/** 收集所有「某方落子即成五」的点（VCF 与强制应手判定复用） */
export function findFivePoints(st: PositionState, color: PlayerColor): number[] {
  const out: number[] = [];
  for (const cell of collectCandidates(st)) {
    if (pointScore(st.cells, cell, color) >= PATTERN_SCORES.FIVE) out.push(cell);
  }
  return out;
}
