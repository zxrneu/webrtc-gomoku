/** 证明检查器的规则原语：全盘枚举，独立于棋型估分和候选裁剪。 */
import type { AiBoard, GameState, PlayerColor } from './types';
import { AI_CELLS, AI_DIRS, AI_SIZE, oppositeOf } from './types';

export function emptyCells(board: AiBoard): number[] {
  const cells: number[] = [];
  for (let at = 0; at < AI_CELLS; at += 1) if (board[at] === 0) cells.push(at);
  return cells;
}

/**
 * 邻域空格枚举（用于威胁搜索热路径）：
 * 仅返回切比雪夫 <= 2 范围内有棋子的空格，跳过远端无威胁空格。
 */
export function neighborEmptyCells(st: { cells: AiBoard; neighbor: Uint8Array | Int8Array; candidateMask?: Uint32Array }): number[] {
  const cells: number[] = [];
  const { cells: board, neighbor, candidateMask } = st;
  if (candidateMask) {
    for (let w = 0; w < 8; w += 1) {
      let word = candidateMask[w] ?? 0;
      while (word !== 0) {
        const lsb = word & -word;
        const bit = 31 - Math.clz32(lsb);
        const cell = (w << 5) | bit;
        if (cell < AI_CELLS) {
          cells.push(cell);
        }
        word ^= lsb;
      }
    }
    return cells;
  }
  for (let at = 0; at < AI_CELLS; at += 1) {
    if (board[at] === 0 && (neighbor[at] ?? 0) > 0) {
      cells.push(at);
    }
  }
  return cells;
}

/** 零分配写入 caller 提供的 Int16Array */
export function neighborEmptyCellsInto(
  st: { cells: AiBoard; neighbor: Uint8Array | Int8Array; candidateMask?: Uint32Array },
  outBuf: Int16Array,
  offset = 0,
): number {
  let count = 0;
  const { cells: board, neighbor, candidateMask } = st;
  if (candidateMask) {
    for (let w = 0; w < 8; w += 1) {
      let word = candidateMask[w] ?? 0;
      while (word !== 0) {
        const lsb = word & -word;
        const bit = 31 - Math.clz32(lsb);
        const cell = (w << 5) | bit;
        if (cell < AI_CELLS) {
          outBuf[offset + count] = cell;
          count += 1;
        }
        word ^= lsb;
      }
    }
    return count;
  }
  for (let at = 0; at < AI_CELLS; at += 1) {
    if (board[at] === 0 && (neighbor[at] ?? 0) > 0) {
      outBuf[offset + count] = at;
      count += 1;
    }
  }
  return count;
}
export function winsAt(board: AiBoard, at: number, color: PlayerColor): boolean {
  if (board[at] !== color) return false;
  const x = at % AI_SIZE;
  const y = Math.floor(at / AI_SIZE);
  return AI_DIRS.some(([dx, dy]) => {
    let count = 1;
    for (const sign of [-1, 1]) {
      let nx = x + dx * sign;
      let ny = y + dy * sign;
      while (nx >= 0 && ny >= 0 && nx < AI_SIZE && ny < AI_SIZE && board[ny * AI_SIZE + nx] === color) {
        count += 1;
        nx += dx * sign;
        ny += dy * sign;
      }
    }
    return count >= 5;
  });
}
export function winningCells(board: AiBoard, color: PlayerColor): number[] {
  return emptyCells(board).filter((at) => {
    board[at] = color;
    const win = winsAt(board, at, color);
    board[at] = 0;
    return win;
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function readProofBoard(game: unknown): AiBoard | null {
  if (!isRecord(game)) return null;
  if (game.size !== AI_SIZE || game.over || !Array.isArray(game.board) || !Array.isArray(game.moves)) return null;
  if (game.board.length !== AI_SIZE || game.moves.length >= AI_CELLS) return null;
  if (!game.board.every((row: unknown) => Array.isArray(row) && row.length === AI_SIZE)) return null;
  if (game.winLine !== null) return null;
  const board = new Int8Array(AI_CELLS);
  let color: PlayerColor = 1;
  for (const move of game.moves) {
    if (!isRecord(move) || typeof move.x !== 'number' || typeof move.y !== 'number') return null;
    if (!Number.isInteger(move.x) || !Number.isInteger(move.y)) return null;
    if (move.x < 0 || move.y < 0 || move.x >= AI_SIZE || move.y >= AI_SIZE || move.c !== color) return null;
    const at = move.y * AI_SIZE + move.x;
    if (board[at] !== 0) return null;
    board[at] = color;
    if (winsAt(board, at, color)) return null;
    color = oppositeOf(color);
  }
  for (let at = 0; at < AI_CELLS; at += 1) {
    const row: unknown = game.board[Math.floor(at / AI_SIZE)];
    if (!Array.isArray(row) || row[at % AI_SIZE] !== board[at]) return null;
  }
  return board;
}

export function isProofGame(value: unknown): value is GameState {
  return readProofBoard(value) !== null;
}
