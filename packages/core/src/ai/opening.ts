/**
 * 开局策略。
 *
 * 只处理两种确定性局面，其余一律返回 null 交给搜索：
 * 1. 空盘执黑 -> 天元 (7,7)；
 * 2. 对手首手落在中心 3×3 -> 在中心 3×3 内取固定应答点。
 * 固定应答（而非随机）是「同局面必同输出」的要求（架构 §3 语义契约 4）。
 */

import type { GameState, PlayerColor, Point } from '../index';
import { AI_BLACK, AI_SIZE, CENTER_IDX, toPoint } from './types';

/** 中心 3×3 的固定应答顺序（不含天元本身，天元已被对手占用时也能取到点） */
const CENTER_REPLIES: readonly number[] = Object.freeze([
  8 * AI_SIZE + 8,
  6 * AI_SIZE + 6,
  8 * AI_SIZE + 6,
  6 * AI_SIZE + 8,
  7 * AI_SIZE + 8,
  8 * AI_SIZE + 7,
  6 * AI_SIZE + 7,
  7 * AI_SIZE + 6,
]);

/** 判断坐标是否落在中心 3×3 */
function inCenterZone(x: number, y: number): boolean {
  return x >= 6 && x <= 8 && y >= 6 && y <= 8;
}

/**
 * 开局策略：空盘执黑 -> (7,7)；对手首手在中心 3×3 -> 中心 3×3 内固定点；其余返回 null。
 * @param g 当前棋局
 * @param color 我方颜色
 */
export function openingMove(g: GameState, color: PlayerColor): Point | null {
  if (g.moves.length === 0) {
    return color === AI_BLACK ? toPoint(CENTER_IDX) : null;
  }
  if (g.moves.length !== 1) return null;
  const first = g.moves[0];
  if (first === undefined) return null;
  if (!inCenterZone(first.x, first.y)) return null;
  for (const idx of CENTER_REPLIES) {
    const x = idx % AI_SIZE;
    const y = Math.floor(idx / AI_SIZE);
    if ((g.board[y]?.[x] ?? 0) === 0) return toPoint(idx);
  }
  return null;
}
