/**
 * 测试公共工具（非测试文件，不被 vitest 收集）。
 *
 * 提供两类能力：
 * 1. 用显式落子序列构造棋局（禁随机，保证基准集可复现）；
 * 2. 独立于引擎实现的「必胜」判定器，用来断言「AI 这一步真的算出了杀」，
 *    而不是断言某个私有实现细节。
 */

import {
  BLACK,
  WHITE,
  applyMove,
  create,
  otherColor,
  winLineAt,
  type GameState,
  type PlayerColor,
  type Point,
} from '../../src/index';

/** 单步描述：[x, y, 颜色] */
export type Step = readonly [number, number, PlayerColor];

/** 按给定序列落子构造棋局；任何非法落子直接抛错，避免用例静默失效 */
export function buildGame(steps: readonly Step[]): GameState {
  const g = create();
  for (const [x, y, c] of steps) {
    const r = applyMove(g, x, y, c);
    if (!r.ok) throw new Error(`非法落子 (${x},${y}) color=${c}: ${r.reason}`);
  }
  return g;
}

/** 黑白交替落子（黑先），两侧长度可差 1 */
export function buildAlternating(
  black: readonly (readonly [number, number])[],
  white: readonly (readonly [number, number])[],
): GameState {
  const steps: Step[] = [];
  const n = Math.max(black.length, white.length);
  for (let i = 0; i < n; i += 1) {
    const b = black[i];
    if (b !== undefined) steps.push([b[0], b[1], BLACK]);
    const w = white[i];
    if (w !== undefined) steps.push([w[0], w[1], WHITE]);
  }
  return buildGame(steps);
}

/** 深拷贝棋局（判定器需要试下而不污染原局面） */
export function cloneGame(g: GameState): GameState {
  return {
    size: g.size,
    board: g.board.map((row) => row.slice()),
    moves: g.moves.map((m) => ({ x: m.x, y: m.y, c: m.c })),
    over: g.over,
    winLine: g.winLine === null ? null : g.winLine.map((p): Point => [p[0], p[1]]),
  };
}

/** 邻域空点（切比雪夫 ≤2 内有子），把判定器的搜索面从 225 压到数十个 */
export function candidateCells(g: GameState): Point[] {
  const out: Point[] = [];
  for (let y = 0; y < g.size; y += 1) {
    for (let x = 0; x < g.size; x += 1) {
      if ((g.board[y]?.[x] ?? 0) !== 0) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= g.size || ny >= g.size) continue;
          if ((g.board[ny]?.[nx] ?? 0) !== 0) {
            near = true;
            break;
          }
        }
      }
      if (near) out.push([x, y]);
    }
  }
  return out;
}

/** 收集「某方落子即形成五连」的空点（与引擎实现无关，用 winLineAt 判定） */
export function fivePoints(g: GameState, color: PlayerColor, cells?: Point[]): Point[] {
  const work = cloneGame(g);
  const scan = cells ?? candidateCells(g);
  const out: Point[] = [];
  for (const [x, y] of scan) {
    const row = work.board[y];
    if (row === undefined) continue;
    if ((row[x] ?? 0) !== 0) continue;
    row[x] = color;
    if (winLineAt(work, x, y, color) !== null) out.push([x, y]);
    row[x] = 0;
  }
  return out;
}

/** 收集「落子后能造出五连威胁」的空点（即冲四/活四手） */
export function fourMakingMoves(g: GameState, color: PlayerColor): Point[] {
  const work = cloneGame(g);
  const cells = candidateCells(g);
  const out: Point[] = [];
  for (const [x, y] of cells) {
    const row = work.board[y];
    if (row === undefined) continue;
    if ((row[x] ?? 0) !== 0) continue;
    row[x] = color;
    if (winLineAt(work, x, y, color) !== null) {
      out.push([x, y]);
    } else if (fivePoints(work, color, cells).length > 0) {
      out.push([x, y]);
    }
    row[x] = 0;
  }
  return out;
}

/** 我方刚落完一手、轮到对方时，我方能否在 plies 手内强制取胜 */
function winsAsNonMover(g: GameState, color: PlayerColor, plies: number): boolean {
  if (plies <= 0) return false;
  const opp = otherColor(color);
  const cells = candidateCells(g);
  const mine = fivePoints(g, color, cells);
  if (mine.length === 0) return false;
  // 对方若能先成五，则我方这条线不成立
  if (fivePoints(g, opp, cells).length > 0) return false;
  if (mine.length >= 2) return true;
  const only = mine[0];
  if (only === undefined) return false;
  const work = cloneGame(g);
  if (!applyMove(work, only[0], only[1], opp).ok) return false;
  return winsAsMover(work, color, plies - 1);
}

/** 轮到我方走时，我方能否在 plies 手内强制取胜（只考虑冲四类强制手） */
function winsAsMover(g: GameState, color: PlayerColor, plies: number): boolean {
  if (plies <= 0) return false;
  if (fivePoints(g, color).length > 0) return true;
  if (plies <= 1) return false;
  for (const mv of fourMakingMoves(g, color)) {
    if (winsAfterMove(g, mv, color, plies)) return true;
  }
  return false;
}

/** 走 mv 之后（轮到对方），我方能否在 plies 手内取胜 */
export function winsAfterMove(g: GameState, mv: Point, color: PlayerColor, plies: number): boolean {
  const work = cloneGame(g);
  const r = applyMove(work, mv[0], mv[1], color);
  if (!r.ok) return false;
  if (r.event === 'win') return true;
  return winsAsNonMover(work, color, plies - 1);
}

/** 我方走 mv 之后，对方是否仍能在 plies 手内强制取胜 */
export function opponentStillWins(g: GameState, mv: Point, color: PlayerColor, plies: number): boolean {
  const work = cloneGame(g);
  if (!applyMove(work, mv[0], mv[1], color).ok) return true;
  return winsAsMover(work, otherColor(color), plies);
}
