/** 威胁描述与依赖关系；只提供搜索提示，不承担胜负证明。 */
import type { AiBoard, PlayerColor } from './types';
import { AI_CELLS, AI_DIRS, AI_SIZE, idxOf, oppositeOf, xOf, yOf } from './types';
import { winsAt } from './proofRules';
import { PATTERN_SCORES, patternAt, pointScore } from './pattern';

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

export function analyzeThreats(board: AiBoard, at: number, color: PlayerColor): Threat[] {
  if (!board || board.length !== AI_CELLS) return [];
  if (at < 0 || at >= AI_CELLS || board[at] !== 0) return [];
  if (color !== 1 && color !== 2) return [];

  const threats: Threat[] = [];
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
        const stones: number[] = [];
        for (const sign of [-1, 1] as const) {
          let step = 1;
          while (true) {
            const nx = x + dx * sign * step;
            const ny = y + dy * sign * step;
            if (!inBounds(nx, ny)) break;
            const idx = idxOf(nx, ny);
            if (board[idx] !== color) break;
            stones.push(idx);
            step += 1;
          }
        }
        threats.push({
          kind: 'five',
          gain: at,
          cost: [],
          rest: [],
          stones: stones.sort((a, b) => a - b),
        });
        continue;
      }

      // 2. 检查成四威胁（在同一线路上再下一子能否成五）
      if (pat === 'OPEN_FOUR' || pat === 'FOUR') {
        const fourWins: number[] = [];
        const fourStones = new Set<number>();

        for (let k = -4; k <= 4; k += 1) {
          if (k === 0) continue;
          const nx = x + dx * k;
          const ny = y + dy * k;
          if (!inBounds(nx, ny)) continue;
          const pos = idxOf(nx, ny);
          if (board[pos] === 0) {
            board[pos] = color;
            if (winsAt(board, pos, color) && winsAt(board, at, color)) {
              fourWins.push(pos);
              // 收集参与构成连线的同色子
              for (let step = -4; step <= 4; step += 1) {
                const sx = nx + dx * step;
                const sy = ny + dy * step;
                if (inBounds(sx, sy)) {
                  const sIdx = idxOf(sx, sy);
                  if (sIdx !== at && sIdx !== pos && board[sIdx] === color) {
                    fourStones.add(sIdx);
                  }
                }
              }
            }
            board[pos] = 0;
          }
        }

        if (fourWins.length > 0) {
          fourWins.sort((a, b) => a - b);
          threats.push({
            kind: 'four',
            gain: at,
            cost: fourWins,
            rest: fourWins,
            stones: Array.from(fourStones).sort((a, b) => a - b),
          });
          continue;
        }
      }

      // 3. 检查成三威胁（在同一线路上再下一子能否形成活四）
      if (pat === 'OPEN_THREE') {
        const threeMakers: number[] = [];
        const threeRest = new Set<number>();
        const threeStones = new Set<number>();

        for (let k = -4; k <= 4; k += 1) {
          if (k === 0) continue;
          const nx = x + dx * k;
          const ny = y + dy * k;
          if (!inBounds(nx, ny)) continue;
          const pos = idxOf(nx, ny);
          if (board[pos] === 0) {
            board[pos] = color;
            // 检查落子 pos 后，该方向上是否能形成活四（>= 2 个成五点）
            const completionWins: number[] = [];
            for (let m = -4; m <= 4; m += 1) {
              if (m === 0 || m === k) continue;
              const mx = x + dx * m;
              const my = y + dy * m;
              if (!inBounds(mx, my)) continue;
              const mPos = idxOf(mx, my);
              if (board[mPos] === 0) {
                board[mPos] = color;
                if (winsAt(board, mPos, color) && winsAt(board, at, color) && winsAt(board, pos, color)) {
                  completionWins.push(mPos);
                }
                board[mPos] = 0;
              }
            }
            if (completionWins.length >= 2) {
              threeMakers.push(pos);
              threeRest.add(pos);
              for (const winPos of completionWins) threeRest.add(winPos);
              // 收集现有己方棋子
              for (let step = -4; step <= 4; step += 1) {
                const sx = x + dx * step;
                const sy = y + dy * step;
                if (inBounds(sx, sy)) {
                  const sIdx = idxOf(sx, sy);
                  if (sIdx !== at && sIdx !== pos && board[sIdx] === color) {
                    threeStones.add(sIdx);
                  }
                }
              }
            }
            board[pos] = 0;
          }
        }

        if (threeMakers.length > 0) {
          threeMakers.sort((a, b) => a - b);
          threats.push({
            kind: 'three',
            gain: at,
            cost: threeMakers,
            rest: Array.from(threeRest).sort((a, b) => a - b),
            stones: Array.from(threeStones).sort((a, b) => a - b),
          });
        }
      }
    }
  } finally {
    board[at] = 0;
  }

  return threats;
}

export function threatDependsOn(parent: Threat, child: Threat): boolean {
  if (!child.stones.includes(parent.gain)) return false;
  if (!parent.cost.includes(child.gain)) return false;
  if (child.stones.some((s) => parent.cost.includes(s))) return false;
  return true;
}

function findWinningPoints(board: AiBoard, color: PlayerColor): number[] {
  const points: number[] = [];
  for (let at = 0; at < AI_CELLS; at += 1) {
    if (board[at] !== 0) continue;
    board[at] = color;
    if (winsAt(board, at, color)) points.push(at);
    board[at] = 0;
  }
  return points;
}

export function orderAttackCandidates(
  board: AiBoard,
  color: PlayerColor,
  mode: 'fours' | 'threats' | 'complete',
  parentThreat?: Threat,
): number[] {
  // 1. 己方直接成五
  const wins = findWinningPoints(board, color);
  if (wins.length > 0) return wins.sort((a, b) => a - b);

  // 2. 对手立即成五：双五则无法防守，单五必须堵
  const opponent = oppositeOf(color);
  const oppWins = findWinningPoints(board, opponent);
  if (oppWins.length >= 2) return [];
  if (oppWins.length === 1) return [oppWins[0]!];

  // 3. 收集并排序候选进攻点
  const threshold = mode === 'fours' ? PATTERN_SCORES.FOUR : PATTERN_SCORES.OPEN_THREE;
  const candidates: { at: number; priority: number; score: number }[] = [];

  for (let at = 0; at < AI_CELLS; at += 1) {
    if (board[at] !== 0) continue;
    const score = pointScore(board, at, color);
    if (mode !== 'complete' && score < threshold) continue;

    const threats = analyzeThreats(board, at, color);
    let priority = 10000;
    if (threats.some((t) => t.kind === 'five')) {
      priority = 50000;
    } else if (threats.length >= 2 && threats.some((t) => t.kind === 'four')) {
      priority = 40000;
    } else if (threats.some((t) => t.kind === 'four')) {
      if (parentThreat && threats.some((t) => threatDependsOn(parentThreat, t))) {
        priority = 35000;
      } else {
        priority = 30000;
      }
    } else if (threats.some((t) => t.kind === 'three')) {
      if (parentThreat && (parentThreat.cost.includes(at) || threats.some((t) => threatDependsOn(parentThreat, t)))) {
        priority = 25000;
      } else {
        priority = 20000;
      }
    }

    candidates.push({ at, priority, score });
  }

  candidates.sort((a, b) => b.priority - a.priority || b.score - a.score || a.at - b.at);
  return candidates.map((c) => c.at);
}
