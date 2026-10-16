/**
 * 五子棋纯逻辑（无 DOM 依赖）
 * 规则：自由五子棋（无禁手），黑方先行，横/竖/斜任一方向先连成 5 子（含长连）即胜。
 */

export const SIZE = 15;
export const EMPTY = 0 as const;
export const BLACK = 1 as const;
export const WHITE = 2 as const;

export type EmptyColor = typeof EMPTY;
export type PlayerColor = typeof BLACK | typeof WHITE;
export type Color = EmptyColor | PlayerColor;

export type Point = [number, number];

export interface Move {
  x: number;
  y: number;
  c: PlayerColor;
}

export interface GameState {
  size: number;
  board: Color[][];
  moves: Move[];
  over: boolean;
  winLine: Point[] | null;
}

export type MoveResult =
  | { ok: true; event: 'move' }
  | { ok: true; event: 'win'; winner: PlayerColor; line: Point[] }
  | { ok: true; event: 'draw' }
  | { ok: false; reason: 'game-over' | 'out-of-board' | 'occupied' | 'not-your-turn' };

export const DIRS: readonly [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

export function create(): GameState {
  return {
    size: SIZE,
    board: Array.from({ length: SIZE }, () => new Array<Color>(SIZE).fill(EMPTY)),
    moves: [],
    over: false,
    winLine: null,
  };
}

export function inBounds(g: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < g.size && y < g.size;
}

/**
 * 黑方先行：已落子数为偶数时轮到黑方
 */
export function currentColor(g: GameState): PlayerColor {
  return g.moves.length % 2 === 0 ? BLACK : WHITE;
}

export function otherColor(c: PlayerColor): PlayerColor {
  return c === BLACK ? WHITE : BLACK;
}

/**
 * 返回 (x, y) 处 color 一方的完整连线（>=5 才返回），否则 null
 */
export function winLineAt(g: GameState, x: number, y: number, color: PlayerColor): Point[] | null {
  for (const [dx, dy] of DIRS) {
    const line: Point[] = [[x, y]];
    for (const step of [1, -1] as const) {
      let nx = x + dx * step;
      let ny = y + dy * step;
      while (inBounds(g, nx, ny) && g.board[ny]?.[nx] === color) {
        if (step === 1) line.push([nx, ny]);
        else line.unshift([nx, ny]);
        nx += dx * step;
        ny += dy * step;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

/**
 * 落子。返回 MoveResult
 */
export function applyMove(g: GameState, x: number, y: number, color: PlayerColor): MoveResult {
  if (g.over) return { ok: false, reason: 'game-over' };
  if (!inBounds(g, x, y)) return { ok: false, reason: 'out-of-board' };
  const row = g.board[y];
  if (!row || row[x] !== EMPTY) return { ok: false, reason: 'occupied' };
  if (color !== currentColor(g)) return { ok: false, reason: 'not-your-turn' };

  row[x] = color;
  g.moves.push({ x, y, c: color });

  const line = winLineAt(g, x, y, color);
  if (line) {
    g.over = true;
    g.winLine = line;
    return { ok: true, event: 'win', winner: color, line };
  }

  if (g.moves.length === g.size * g.size) {
    g.over = true;
    return { ok: true, event: 'draw' };
  }

  return { ok: true, event: 'move' };
}

export function undo(g: GameState): Move | null {
  const m = g.moves.pop();
  if (!m) return null;
  const row = g.board[m.y];
  if (row) row[m.x] = EMPTY;
  g.over = false;
  g.winLine = null;
  return m;
}
