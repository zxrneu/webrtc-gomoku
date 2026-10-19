/** AND/OR 威胁搜索。攻击方可选择一手；防守方的每个合法应手都须成立。 */
import type { PlayerColor } from './types';
import { AI_CELLS, oppositeOf } from './types';
import type { PositionState } from './evaluate';
import { placeStone, removeStone } from './evaluate';
import { PATTERN_SCORES, pointScore } from './pattern';
import type { WinningProof } from './proof';
import { winsAt } from './proofRules';
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

const scratchAttackAt = new Int16Array(AI_CELLS);
const scratchAttackScore = new Int32Array(AI_CELLS);

const scratchDefenseAt = new Int16Array(AI_CELLS);
const scratchDefenseScore = new Int32Array(AI_CELLS);

function attackMoves(st: PositionState, ctx: ThreatContext): number[] {
  const wins = findFivePoints(st, ctx.attacker);
  if (wins.length > 0) return wins;
  const blocks = findFivePoints(st, oppositeOf(ctx.attacker));
  if (blocks.length > 0) return blocks.length === 1 ? blocks : [];
  const threshold = ctx.mode === 'fours' ? PATTERN_SCORES.FOUR : PATTERN_SCORES.OPEN_THREE;

  const attackAt = st.scratch?.attackAt ?? scratchAttackAt;
  const attackScore = st.scratch?.attackScore ?? scratchAttackScore;

  let count = 0;
  const mask = st.candidateMask;
  if (mask) {
    for (let w = 0; w < 8; w += 1) {
      let word = mask[w] ?? 0;
      while (word !== 0) {
        const lsb = word & -word;
        const bit = 31 - Math.clz32(lsb);
        const cell = (w << 5) | bit;
        word ^= lsb;
        if (cell < AI_CELLS) {
          const score = pointScore(st.cells, cell, ctx.attacker);
          if (ctx.mode === 'complete' || score >= threshold) {
            attackAt[count] = cell;
            attackScore[count] = score;
            count += 1;
          }
        }
      }
    }
  } else {
    for (let cell = 0; cell < AI_CELLS; cell += 1) {
      if (st.cells[cell] !== 0) continue;
      if ((st.neighbor[cell] ?? 0) === 0) continue;
      const score = pointScore(st.cells, cell, ctx.attacker);
      if (ctx.mode === 'complete' || score >= threshold) {
        attackAt[count] = cell;
        attackScore[count] = score;
        count += 1;
      }
    }
  }

  if (count === 0) return [];

  // 原地插入排序（降序 score，升序 idx 稳定 tie-break）
  for (let i = 1; i < count; i += 1) {
    const curAt = attackAt[i]!;
    const curScore = attackScore[i]!;
    let j = i - 1;
    while (j >= 0) {
      const prevScore = attackScore[j]!;
      const prevAt = attackAt[j]!;
      if (prevScore < curScore || (prevScore === curScore && prevAt > curAt)) {
        attackAt[j + 1] = prevAt;
        attackScore[j + 1] = prevScore;
        j -= 1;
      } else {
        break;
      }
    }
    attackAt[j + 1] = curAt;
    attackScore[j + 1] = curScore;
  }

  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = attackAt[i]!;
  }
  return out;
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
  const opp = oppositeOf(defender);
  const defenseAt = st.scratch?.defenseAt ?? scratchDefenseAt;
  const defenseScore = st.scratch?.defenseScore ?? scratchDefenseScore;
  let count = 0;
  for (let cell = 0; cell < AI_CELLS; cell += 1) {
    if (st.cells[cell] !== 0) continue;
    const score = pointScore(st.cells, cell, defender) + pointScore(st.cells, cell, opp);
    defenseAt[count] = cell;
    defenseScore[count] = score;
    count += 1;
  }

  if (count === 0) return [];

  for (let i = 1; i < count; i += 1) {
    const curAt = defenseAt[i]!;
    const curScore = defenseScore[i]!;
    let j = i - 1;
    while (j >= 0) {
      const prevScore = defenseScore[j]!;
      const prevAt = defenseAt[j]!;
      if (prevScore < curScore || (prevScore === curScore && prevAt > curAt)) {
        defenseAt[j + 1] = prevAt;
        defenseScore[j + 1] = prevScore;
        j -= 1;
      } else {
        break;
      }
    }
    defenseAt[j + 1] = curAt;
    defenseScore[j + 1] = curScore;
  }

  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = defenseAt[i]!;
  }
  return out;
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
