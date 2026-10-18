/** 胜法证书与独立检查器。所有防守分支必须覆盖，估分不参与证明。 */
import type { AiBoard, GameState, PlayerColor } from './types';
import { AI_CELLS, oppositeOf } from './types';
import { emptyCells, readProofBoard, winningCells, winsAt } from './proofRules';

export type WinningProof =
  | { kind: 'five'; at: number }
  | { kind: 'fork'; at: number }
  | { kind: 'force'; at: number; reply: number; next: WinningProof }
  | { kind: 'branch'; at: number; replies: readonly { at: number; proof: WinningProof }[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isEmpty(board: AiBoard, at: unknown): at is number {
  return typeof at === 'number' && Number.isInteger(at) && at >= 0 && at < AI_CELLS && board[at] === 0;
}

class ProofChecker {
  private remaining = 200000;
  private readonly path = new Set<object>();
  constructor(private readonly board: AiBoard, private readonly attacker: PlayerColor) {}

  *verify(proof: unknown): Generator<void, boolean, void> {
    yield;
    if (!isRecord(proof) || this.remaining-- <= 0 || this.path.has(proof)) return false;
    if (!isEmpty(this.board, proof.at)) return false;
    this.path.add(proof);
    this.board[proof.at] = this.attacker;
    try { return yield* this.afterAttack(proof); }
    finally { this.board[proof.at] = 0; this.path.delete(proof); }
  }
  private *afterAttack(proof: Record<string, unknown>): Generator<void, boolean, void> {
    if (proof.kind === 'five') return winsAt(this.board, Number(proof.at), this.attacker);
    if (winsAt(this.board, Number(proof.at), this.attacker)) return false;
    const defender = oppositeOf(this.attacker);
    if (winningCells(this.board, defender).length > 0) return false;
    const wins = winningCells(this.board, this.attacker);
    if (proof.kind === 'fork') return wins.length >= 2;
    if (proof.kind === 'force') {
      const reply = wins[0];
      if (wins.length !== 1 || reply === undefined || proof.reply !== reply) return false;
      return yield* this.afterReply(reply, proof.next);
    }
    if (proof.kind !== 'branch' || !Array.isArray(proof.replies)) return false;
    const legal = emptyCells(this.board);
    if (proof.replies.length !== legal.length || legal.length === 0) return false;
    const seen = new Set<number>();
    for (const reply of proof.replies) {
      if (!isRecord(reply) || !isEmpty(this.board, reply.at) || seen.has(reply.at)) return false;
      seen.add(reply.at);
      if (!(yield* this.afterReply(reply.at, reply.proof))) return false;
    }
    return true;
  }
  private *afterReply(at: number, proof: unknown): Generator<void, boolean, void> {
    const defender = oppositeOf(this.attacker);
    this.board[at] = defender;
    try { return !winsAt(this.board, at, defender) && (yield* this.verify(proof)); }
    finally { this.board[at] = 0; }
  }
}

export function* verifyProofSteps(
  game: GameState, color: PlayerColor, proof: unknown,
): Generator<void, boolean, void> {
  const board = readProofBoard(game);
  if (!board || color !== (game.moves.length % 2 === 0 ? 1 : 2)) return false;
  return yield* new ProofChecker(board, color).verify(proof);
}
export function verifyWinningProof(game: GameState, color: PlayerColor, proof: unknown): boolean {
  const steps = verifyProofSteps(game, color, proof);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
