/** AND/OR 威胁搜索。攻击方可选择一手；防守方的每个合法应手都须成立。 */
import type { PlayerColor } from './types';
import { oppositeOf } from './types';
import type { PositionState } from './evaluate';
import { placeStone, removeStone } from './evaluate';
import { PATTERN_SCORES, pointScore } from './pattern';
import type { WinningProof } from './proof';
import { emptyCells, winsAt } from './proofRules';
import { findFivePoints } from './movegen';

export interface ThreatContext {
  readonly attacker: PlayerColor;
  readonly maxNodes: number;
  readonly mode: 'fours' | 'threats' | 'complete';
  readonly now?: () => number;
  readonly deadline?: number;
  nodes: number;
  exhausted: boolean;
}

function attackMoves(st: PositionState, ctx: ThreatContext): number[] {
  const wins = findFivePoints(st, ctx.attacker);
  if (wins.length) return wins;
  const blocks = findFivePoints(st, oppositeOf(ctx.attacker));
  if (blocks.length) return blocks.length === 1 ? blocks : [];
  const threshold = ctx.mode === 'fours' ? PATTERN_SCORES.FOUR : PATTERN_SCORES.OPEN_THREE;
  return emptyCells(st.cells).map((at) => ({ at, score: pointScore(st.cells, at, ctx.attacker) }))
    .filter(({ score }) => ctx.mode === 'complete' || score >= threshold)
    .sort((a, b) => b.score - a.score || a.at - b.at).map(({ at }) => at);
}

export function* searchThreatProof(
  st: PositionState, ctx: ThreatContext, attacks: number,
): Generator<void, WinningProof | null, void> {
  ctx.nodes += 1;
  yield;
  if (attacks <= 0 || ctx.exhausted) return null;
  if ((ctx.nodes & 15) === 0 && ctx.now && ctx.deadline !== undefined && ctx.now() >= ctx.deadline) {
    ctx.exhausted = true;
    return null;
  }
  if (ctx.nodes > ctx.maxNodes) { ctx.exhausted = true; return null; }
  for (const at of attackMoves(st, ctx)) {
    yield;
    placeStone(st, at, ctx.attacker);
    try {
      const proof = yield* afterAttack(st, ctx, { at, attacks });
      if (proof) return proof;
    } finally { removeStone(st, at); }
    if (ctx.exhausted) break;
  }
  return null;
}

function* afterAttack(
  st: PositionState, ctx: ThreatContext, step: { at: number; attacks: number },
): Generator<void, WinningProof | null, void> {
  if (winsAt(st.cells, step.at, ctx.attacker)) return { kind: 'five', at: step.at };
  const defender = oppositeOf(ctx.attacker);
  if (findFivePoints(st, defender).length > 0) return null;
  const wins = findFivePoints(st, ctx.attacker);
  if (wins.length >= 2) return { kind: 'fork', at: step.at };
  const block = wins[0];
  if (block !== undefined) {
    const next = yield* afterReply(st, ctx, { at: block, attacks: step.attacks - 1 });
    return next ? { kind: 'force', at: step.at, reply: block, next } : null;
  }
  if (ctx.mode === 'fours') return null;
  const replies: { at: number; proof: WinningProof }[] = [];
  for (const at of defenseMoves(st, defender)) {
    const proof = yield* afterReply(st, ctx, { at, attacks: step.attacks - 1 });
    if (!proof) return null;
    replies.push({ at, proof });
  }
  return replies.length ? { kind: 'branch', at: step.at, replies } : null;
}
function defenseMoves(st: PositionState, defender: PlayerColor): number[] {
  return emptyCells(st.cells).map((at) => ({ at, score: pointScore(st.cells, at, defender) +
    pointScore(st.cells, at, oppositeOf(defender)) }))
    .sort((a, b) => b.score - a.score || a.at - b.at).map(({ at }) => at);
}
function* afterReply(
  st: PositionState, ctx: ThreatContext, step: { at: number; attacks: number },
): Generator<void, WinningProof | null, void> {
  yield;
  const defender = oppositeOf(ctx.attacker);
  placeStone(st, step.at, defender);
  try {
    if (winsAt(st.cells, step.at, defender)) return null;
    return yield* searchThreatProof(st, ctx, step.attacks);
  } finally { removeStone(st, step.at); }
}
