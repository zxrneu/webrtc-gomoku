/** Worker 消息的可克隆契约与运行时校验。 */
import type { AiOptions, AiSearchStats, GameState, PlayerColor, Point } from '@webrtc-gomoku/core';

type SearchOptions = Omit<AiOptions, 'now'>;
export type WorkerRequest =
  | { t: 'search'; id: number; game: GameState; color: PlayerColor; options: SearchOptions }
  | { t: 'cancel'; id: number };
export interface WorkerResponse {
  t: 'result';
  id: number;
  move: Point | null;
  stats: AiSearchStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 15;
}
function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 2 && value.every(isCoordinate);
}
function isColor(value: unknown): value is PlayerColor { return value === 1 || value === 2; }
function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isGame(value: unknown): value is GameState {
  if (!isRecord(value) || value.size !== 15 || typeof value.over !== 'boolean') return false;
  if (!Array.isArray(value.board) || value.board.length !== 15) return false;
  if (!value.board.every((row: unknown) => Array.isArray(row) && row.length === 15 &&
    row.every((cell: unknown) => cell === 0 || isColor(cell)))) return false;
  if (!Array.isArray(value.moves) || value.moves.length > 225) return false;
  if (!value.moves.every((move: unknown) => isRecord(move) && isCoordinate(move.x) &&
    isCoordinate(move.y) && isColor(move.c))) return false;
  return value.winLine === null || (Array.isArray(value.winLine) && value.winLine.every(isPoint));
}
function isOptions(value: unknown): value is SearchOptions {
  if (!isRecord(value) || 'now' in value) return false;
  if (value.backend !== undefined && value.backend !== 'ts' && value.backend !== 'rust-wasm') return false;
  if (value.difficulty !== undefined && !['easy', 'normal', 'hard'].includes(String(value.difficulty))) return false;
  return ['timeBudgetMs', 'maxDepth', 'maxNodes', 'vcfMaxNodes', 'pnsMaxNodes', 'pnsTimeBudgetMs'].every((key) => value[key] === undefined ||
    (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0));
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || !isId(value.id)) return false;
  if (value.t === 'cancel') return true;
  return value.t === 'search' && isColor(value.color) && isGame(value.game) && isOptions(value.options);
}
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value) || value.t !== 'result' || !isId(value.id)) return false;
  if (value.move !== null && !isPoint(value.move)) return false;
  const stats = value.stats;
  if (!isRecord(stats) || typeof stats.fromOpening !== 'boolean') return false;
  if (stats.backend !== undefined && stats.backend !== 'ts' && stats.backend !== 'rust-wasm') return false;
  if (!['time', 'nodes', 'depth', 'aborted', 'none'].includes(String(stats.cutoff))) return false;
  return ['depth', 'nodes', 'elapsedMs', 'bestScore'].every((key) =>
    typeof stats[key] === 'number' && Number.isFinite(stats[key]));
}
