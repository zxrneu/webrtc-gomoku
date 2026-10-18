/** 有限预算的证明搜索会话，耗尽预算只能返回 unknown。 */
import type { GameState, PlayerColor, Point } from './types';
import { toPoint } from './types';
import { createPositionState } from './evaluate';
import { verifyWinningProof, type WinningProof } from './proof';
import { readProofBoard } from './proofRules';
import { searchThreatProof, type ThreatContext } from './threatSearch';
import { searchPnProof } from './pnSearch';

export interface ProofOptions {
  algorithm?: 'dfs' | 'pn';
  maxAttacks?: number;
  maxNodes?: number;
  timeBudgetMs?: number;
  now?: () => number;
  mode?: ThreatContext['mode'];
}
export type ProofResult =
  | { status: 'win'; move: Point; proof: WinningProof; nodes: number }
  | { status: 'unknown'; reason: 'searching' | 'depth' | 'nodes' | 'time' | 'aborted' | 'invalid'; nodes: number };
export interface ProofSession {
  step(budgetMs?: number): boolean;
  result(): ProofResult;
  abort(): void;
}

function validOptions(options: ProofOptions): boolean {
  if (options.algorithm !== undefined && !['dfs', 'pn'].includes(options.algorithm)) return false;
  if (!['fours', 'threats', 'complete'].includes(options.mode ?? 'threats')) return false;
  if (![options.maxNodes, options.maxAttacks].every((value) => value === undefined ||
    (Number.isSafeInteger(value) && value >= 0))) return false;
  return options.timeBudgetMs === undefined || (Number.isFinite(options.timeBudgetMs) && options.timeBudgetMs >= 0);
}

class Session implements ProofSession {
  private readonly ctx: ThreatContext;
  private readonly work: Generator<void, WinningProof | null, void> | null;
  private readonly deadline: number;
  private outcome: ProofResult = { status: 'unknown', reason: 'searching', nodes: 0 };
  constructor(private readonly game: GameState, private readonly color: PlayerColor, private readonly options: ProofOptions) {
    this.deadline = (options.now?.() ?? 0) + (options.timeBudgetMs ?? 1000);
    this.ctx = {
      attacker: color,
      nodes: 0,
      exhausted: false,
      maxNodes: options.maxNodes ?? 1000,
      mode: options.mode ?? 'threats',
      now: options.now,
      deadline: options.now ? this.deadline : undefined,
    };
    const board = validOptions(options) ? readProofBoard(game) : null;
    const searchFn = options.algorithm === 'pn' ? searchPnProof : searchThreatProof;
    this.work = board && color === (game.moves.length % 2 === 0 ? 1 : 2)
      ? searchFn(createPositionState(board), this.ctx, options.maxAttacks ?? 3) : null;
    if (!this.work) this.outcome = { status: 'unknown', reason: 'invalid', nodes: 0 };
  }
  step(budgetMs = 32): boolean {
    if (!this.work || this.outcome.status !== 'unknown' || this.outcome.reason !== 'searching') return false;
    const now = this.options.now;
    const slice = (now?.() ?? 0) + Math.max(1, budgetMs);
    let ticks = 0;
    while (true) {
      if (now) {
        const time = now();
        if (time >= this.deadline) { this.stop('time'); return false; }
        if (time >= slice && ticks > 0) return true;
      }
      const next = this.work.next();
      if (next.done) {
        const proof = next.value;
        const valid = proof && verifyWinningProof(this.game, this.color, proof);
        this.outcome = valid
          ? { status: 'win', move: toPoint(proof.at), proof, nodes: this.ctx.nodes }
          : { status: 'unknown', reason: this.ctx.exhausted ? 'nodes' : 'depth', nodes: this.ctx.nodes };
        return false;
      }
      ticks += 1;
    }
  }
  result(): ProofResult { return { ...this.outcome, nodes: this.ctx.nodes }; }
  abort(): void { if (this.outcome.status === 'unknown' && this.outcome.reason === 'searching') this.stop('aborted'); }
  private stop(reason: 'time' | 'aborted'): void {
    this.work?.return(null);
    this.outcome = { status: 'unknown', reason, nodes: this.ctx.nodes };
  }
}
export function createProofSession(game: GameState, color: PlayerColor, options: ProofOptions = {}): ProofSession {
  return new Session(game, color, options);
}
