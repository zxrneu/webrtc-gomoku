/**
 * 搜索：Negamax + α-β + 置换表 + 迭代加深 + VCF 算杀。
 *
 * 三个关键设计：
 * 1. **只提交已完成层**：分片中断时丢弃未完成层的根节点结果，避免落子抖动（架构 §9 R2）。
 *    生成器保留递归栈和棋盘，分片暂停后从同一节点继续，不跳过候选手。
 * 2. **硬规则短路优先于深度**：成五/堵五由 movegen 直接给出唯一候选，与预算无关。
 * 3. **算杀先行**：独立预算搜索连续冲四/活三，只有通过规则复验才标记已证明。
 */

import type { GameState, PlayerColor, Point } from '../index';
import type { AiOptions, AiSearchStats, AiSession, CutoffReason, Difficulty } from './types';
import {
  AI_CELLS,
  AI_SIZE,
  AI_WHITE,
  asPlayer,
  cellAtIdx,
  fromGameState,
  oppositeOf,
  toPoint,
} from './types';
import type { ResolvedOptions } from './config';
import {
  DEFAULT_SLICE_MS,
  ROOT_BRANCH_LIMIT,
  VCF_DEPTH,
  FAST_VCF_TIME_BUDGET_MS,
  PNS_TIME_BUDGET_MS,
  PNS_ATTACK_LIMIT,
  DEFENSE_CHECK_TIME_BUDGET_MS,
  DEFENSE_ATTACK_LIMIT,
  DEFENSE_NODE_LIMIT,
  branchLimitFor,
  resolveOptions,
} from './config';
import { PATTERN_SCORES } from './pattern';
import type { PositionState } from './evaluate';
import { MATE_SCORE, createPositionState, evalFor, placeStone, removeStone } from './evaluate';
import { generateMoves, generateMovesInto } from './movegen';
import { verifyProofSteps, type WinningProof } from './proof';
import { readProofBoard } from './proofRules';
import { searchThreatProof, type ThreatContext } from './threatSearch';
import { searchPnProof } from './pnSearch';
import { orderAttackCandidates } from './dependency';
import type { TranspositionTable } from './tt';
import {
  FLAG_EXACT,
  FLAG_LOWER,
  FLAG_UPPER,
  createTranspositionTable,
} from './tt';
import { ZOBRIST, pieceHi, pieceLo } from './zobrist';
import { openingMove } from './opening';

/** 无穷大分值 */
const INF = 1 << 30;

/** 复用型 TT 条目 */
const ttScratch = { score: 0, depth: 0, flag: 0, move: -1 };

/** 内部停止原因（'slice' 只是暂停，其余是终止） */
type StopReason = 'slice' | 'total' | 'nodes' | 'aborted';

/** 输入合法性：size / 终局 / 棋盘与落子记录一致性 / 轮次 */
function isValidInput(g: GameState, color: PlayerColor): boolean {
  return readProofBoard(g) !== null && color === (g.moves.length % 2 === 0 ? 1 : 2);
}

/** 非法输入时返回的空会话：一切调用都安全降级为 null */
class NullSession implements AiSession {
  readonly difficulty: Difficulty;

  constructor(difficulty: Difficulty) {
    this.difficulty = difficulty;
  }

  step(): boolean {
    return false;
  }

  result(): Point | null {
    return null;
  }

  stats(): AiSearchStats {
    return { depth: 0, nodes: 0, elapsedMs: 0, cutoff: 'none', bestScore: 0, fromOpening: false, proofStatus: 'unknown' };
  }

  abort(): void {
    // 空会话无需清理
  }
}

/** 一次搜索会话 */
export class SearchSession implements AiSession {
  readonly difficulty: Difficulty;

  private readonly me: PlayerColor;
  private readonly resolved: ResolvedOptions;
  private readonly st: PositionState;
  private readonly tt: TranspositionTable;
  private readonly vcfDepth: number;
  private readonly gameSnapshot: GameState;
  private winningProof: WinningProof | undefined;
  private readonly startedAt: number;
  private readonly totalDeadline: number | null;

  private sliceDeadline: number | null = null;
  private elapsed = 0;
  private nodes = 0;
  private vcfNodes = 0;
  private activeContext: ThreatContext | null = null;
  private keyLo = 0;
  private keyHi = 0;
  private stop: StopReason | null = null;
  private finished = false;
  private cutoff: CutoffReason = 'none';
  private bestRoot = -1;
  private bestScore = 0;
  private completedDepth = 0;
  private currentDepth = 0;
  private rootMoves: number[] = [];
  private defendedRootMoves: number[] | null = null;
  private rootIndex = 0;
  private rootAlpha = -INF;
  private rootBest = -1;
  private rootBestScore = -INF;
  private fromOpening = false;
  private work: Generator<void, void, void> | null = null;
  /** 最大搜索层数支持（最大 ply=32，每层分支上限 16，共 512 个槽位） */
  private static readonly MAX_PLY = 32;
  private static readonly PLY_STRIDE = 16;
  private readonly plyMoves = new Int16Array(SearchSession.MAX_PLY * SearchSession.PLY_STRIDE);

  constructor(g: GameState, color: PlayerColor, resolved: ResolvedOptions) {
    this.resolved = resolved;
    this.gameSnapshot = { ...g, board: g.board.map((row) => row.slice()), moves: g.moves.map((move) => ({ ...move })) };
    this.difficulty = resolved.difficulty;
    this.me = color;
    this.st = createPositionState(fromGameState(g));
    this.tt = createTranspositionTable();
    this.vcfDepth = VCF_DEPTH[resolved.difficulty];
    const now = resolved.now;
    this.startedAt = now === null ? 0 : now();
    this.totalDeadline = now === null ? null : this.startedAt + resolved.timeBudgetMs;
    let lo = 0;
    let hi = 0;
    for (let cell = 0; cell < AI_CELLS; cell += 1) {
      const c = cellAtIdx(this.st.cells, cell);
      if (c === 0) continue;
      const pc = asPlayer(c);
      lo ^= pieceLo(ZOBRIST, cell, pc);
      hi ^= pieceHi(ZOBRIST, cell, pc);
    }
    this.keyLo = lo;
    this.keyHi = hi;
    // 开局策略是确定性知识，直接在此收口，避免进入无意义搜索
    this.bestRoot = generateMoves(this.st, color, ROOT_BRANCH_LIMIT)[0] ?? -1;
    const open = openingMove(g, color);
    if (open !== null) {
      this.fromOpening = true;
      this.bestRoot = open[1] * AI_SIZE + open[0];
      this.bestScore = 0;
      this.completedDepth = 0;
      this.finish('depth');
    }
  }

  step(budgetMs: number = DEFAULT_SLICE_MS): boolean {
    if (this.finished) return false;
    this.beginSlice(budgetMs);
    if (this.stop !== null) {
      this.afterLoop();
      return !this.finished;
    }
    this.work ??= this.search();
    let ticks = 0;
    while (!this.finished && this.stop === null) {
      if (this.work.next().done) this.finish('depth');
      ticks += 1;
      if (ticks === 1 || (ticks & 15) === 0) {
        this.checkTime(false);
      }
    }
    this.afterLoop();
    if (this.finished) this.work.return();
    return !this.finished;
  }

  private *search(): Generator<void, void, void> {
    const win = yield* this.runVcf();
    if (win >= 0) {
      this.bestRoot = win;
      this.bestScore = MATE_SCORE - 1;
      this.finish('depth');
      return;
    }
    yield* this.excludeCounterKills();
    while (!this.finished && this.stop === null) {
      if (this.rootMoves.length === 0) this.beginDepth();
      if (this.finished) return;
      const move = this.rootMoves[this.rootIndex];
      if (move !== undefined) yield* this.searchRootMove(move);
      if (this.stop !== null) return;
      this.rootIndex += 1;
      if (this.rootIndex >= this.rootMoves.length) this.commitDepth();
    }
  }

  result(): Point | null {
    if (this.bestRoot < 0) return null;
    return toPoint(this.bestRoot);
  }

  stats(): AiSearchStats {
    return {
      depth: this.completedDepth,
      nodes: this.nodes + this.vcfNodes + (this.activeContext?.nodes ?? 0),
      elapsedMs: this.elapsed,
      cutoff: this.cutoff,
      bestScore: this.bestScore,
      fromOpening: this.fromOpening,
      proofStatus: this.winningProof ? 'win' : 'unknown',
      ...(this.winningProof ? { winningProof: this.winningProof } : {}),
    };
  }

  abort(): void {
    this.stop = 'aborted';
    this.finished = true;
    this.cutoff = 'aborted';
    this.work?.return();
  }

  // ---------- 内部实现 ----------

  private finish(reason: CutoffReason): void {
    this.finished = true;
    if (this.cutoff === 'none') this.cutoff = reason;
  }

  private beginSlice(budgetMs: number): void {
    this.stop = null;
    const now = this.resolved.now;
    if (now === null) {
      this.sliceDeadline = null;
      return;
    }
    const t = now();
    this.elapsed = t - this.startedAt;
    if (this.totalDeadline !== null && t >= this.totalDeadline) {
      this.stop = 'total';
      return;
    }
    this.sliceDeadline = t + Math.max(1, budgetMs);
  }

  private afterLoop(): void {
    if (this.stop === 'slice') {
      // 只是暂停：保留根循环进度，下一片接着搜（已完成的层已提交，未完成层未提交）
      this.stop = null;
      return;
    }
    if (this.stop === 'total') {
      this.cutoff = 'time';
      this.finished = true;
      return;
    }
    if (this.stop === 'nodes') {
      this.cutoff = 'nodes';
      this.finished = true;
      return;
    }
    if (this.stop === 'aborted') {
      this.cutoff = 'aborted';
      this.finished = true;
    }
  }

  /** 每 N 个节点检查一次时间；时间源缺失时直接返回 */
  private checkTime(firstTick: boolean): void {
    if (this.stop !== null) return;
    const now = this.resolved.now;
    if (now === null) return;
    const t = now();
    this.elapsed = t - this.startedAt;
    if (this.totalDeadline !== null && t >= this.totalDeadline) {
      this.stop = 'total';
      return;
    }
    if (!firstTick && this.sliceDeadline !== null && t >= this.sliceDeadline) this.stop = 'slice';
  }

  private beginDepth(): void {
    const nextDepth = this.currentDepth === 0 ? 2 : this.currentDepth + 2;
    if (nextDepth > this.resolved.maxDepth) {
      this.finish('depth');
      return;
    }
    this.currentDepth = nextDepth;
    const moves = this.defendedRootMoves?.slice() ?? generateMoves(this.st, this.me, ROOT_BRANCH_LIMIT);
    if (moves.length === 0) {
      this.finish('depth');
      return;
    }
    this.rootMoves = moves;
    this.rootIndex = 0;
    this.rootAlpha = -INF;
    this.rootBest = -1;
    this.rootBestScore = -INF;
    if (moves.length === 1 && this.defendedRootMoves === null) {
      // 唯一候选（成五 / 堵五 / 单点应手）：无需再深搜
      this.rootBest = moves[0] ?? -1;
      this.rootBestScore = evalFor(this.st, this.me);
      this.commitDepth();
      this.finish('depth');
    }
  }

  private commitDepth(): void {
    if (this.rootBest >= 0) {
      this.bestRoot = this.rootBest;
      this.bestScore = Math.round(this.rootBestScore);
      this.completedDepth = this.currentDepth;
    }
    this.rootMoves = [];
    this.rootIndex = 0;
  }

  private *searchRootMove(move: number): Generator<void, void, void> {
    this.doPlace(move, this.me);
    let score: number;
    try {
      score = (this.st.pointScore[move] ?? 0) >= PATTERN_SCORES.FIVE
        ? MATE_SCORE - 1
        : -(yield* this.negamax(this.currentDepth - 1, -INF, -this.rootAlpha, oppositeOf(this.me), 1));
    } finally {
      this.doRemove(move, this.me);
    }
    if (this.stop !== null) return;
    if (score > this.rootBestScore) {
      this.rootBestScore = score;
      this.rootBest = move;
    }
    if (score > this.rootAlpha) this.rootAlpha = score;
  }

  private *negamax(
    depth: number,
    alphaIn: number,
    betaIn: number,
    color: PlayerColor,
    ply: number,
  ): Generator<void, number, void> {
    this.nodes += 1;
    if (this.nodes >= this.resolved.maxNodes) {
      if (this.stop === null) this.stop = 'nodes';
      return 0;
    }
    yield;
    if (this.stop !== null) return 0;
    if (depth <= 0) return evalFor(this.st, color);

    const lo = color === AI_WHITE ? this.keyLo ^ ZOBRIST.sideLo : this.keyLo;
    const hi = color === AI_WHITE ? this.keyHi ^ ZOBRIST.sideHi : this.keyHi;
    let alpha = alphaIn;
    let beta = betaIn;
    let ttMove = -1;
    if (this.tt.probe(lo, hi, ttScratch)) {
      ttMove = ttScratch.move;
      if (ttScratch.depth >= depth) {
        if (ttScratch.flag === FLAG_EXACT) return ttScratch.score;
        if (ttScratch.flag === FLAG_LOWER && ttScratch.score > alpha) alpha = ttScratch.score;
        else if (ttScratch.flag === FLAG_UPPER && ttScratch.score < beta) beta = ttScratch.score;
        if (alpha >= beta) return ttScratch.score;
      }
    }

    if (ply >= SearchSession.MAX_PLY) return evalFor(this.st, color);

    const plyOffset = ply * SearchSession.PLY_STRIDE;
    const count = generateMovesInto(this.st, color, branchLimitFor(depth), this.plyMoves, plyOffset);
    if (count === 0) return evalFor(this.st, color);

    // TT 走法复核与置顶：直接在 this.plyMoves 局部切片内右移置顶，零数组分配与零 splice/unshift
    if (ttMove >= 0) {
      let ttIdx = -1;
      for (let i = 0; i < count; i += 1) {
        if (this.plyMoves[plyOffset + i] === ttMove) {
          ttIdx = i;
          break;
        }
      }
      if (ttIdx > 0) {
        const saved = this.plyMoves[plyOffset + ttIdx]!;
        for (let j = ttIdx; j > 0; j -= 1) {
          this.plyMoves[plyOffset + j] = this.plyMoves[plyOffset + j - 1]!;
        }
        this.plyMoves[plyOffset] = saved;
      }
    }

    const origAlpha = alpha;
    const opp = oppositeOf(color);
    let best = -INF;
    let bestMove = -1;
    for (let i = 0; i < count; i += 1) {
      const move = this.plyMoves[plyOffset + i]!;
      this.doPlace(move, color);
      let score: number;
      try {
        score = (this.st.pointScore[move] ?? 0) >= PATTERN_SCORES.FIVE
          ? MATE_SCORE - ply - 1
          : -(yield* this.negamax(depth - 1, -beta, -alpha, opp, ply + 1));
      } finally {
        this.doRemove(move, color);
      }
      if (this.stop !== null) return 0;
      if (score > best) {
        best = score;
        bestMove = move;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    let flag = FLAG_EXACT;
    if (best <= origAlpha) flag = FLAG_UPPER;
    else if (best >= beta) flag = FLAG_LOWER;
    this.tt.store(lo, hi, best, depth, flag, bestMove);
    return best;
  }

  private doPlace(cell: number, color: PlayerColor): void {
    placeStone(this.st, cell, color);
    this.keyLo ^= pieceLo(ZOBRIST, cell, color);
    this.keyHi ^= pieceHi(ZOBRIST, cell, color);
  }

  private doRemove(cell: number, color: PlayerColor): void {
    removeStone(this.st, cell);
    this.keyLo ^= pieceLo(ZOBRIST, cell, color);
    this.keyHi ^= pieceHi(ZOBRIST, cell, color);
  }

  /** 只排除有独立证明的反杀手；未搜到反杀不代表安全或必胜。反杀检查包含活三威胁，采用 PNS 求解。 */
  private *excludeCounterKills(): Generator<void, void, void> {
    if (this.difficulty !== 'hard') return;
    const opponent = oppositeOf(this.me);
    if (orderAttackCandidates(this.st, opponent, 'threats').length === 0) {
      return;
    }
    const moves = generateMoves(this.st, this.me, ROOT_BRANCH_LIMIT);
    if (moves.length < 2) return;
    const remaining = moves.slice();
    this.defendedRootMoves = remaining;
    const now = this.resolved.now;
    const current = now !== null ? now() : 0;
    const defenseLimitMs = now !== null
      ? Math.min(DEFENSE_CHECK_TIME_BUDGET_MS, Math.max(0, (this.totalDeadline ?? 0) - current))
      : null;
    const defenseDeadline = (now !== null && defenseLimitMs !== null) ? current + defenseLimitMs : null;

    for (const move of moves) {
      if (defenseDeadline !== null && now!() >= defenseDeadline) break;
      if (this.stop !== null) break;
      this.doPlace(move, this.me);
      let proof: WinningProof | null = null;
      let nodesUsed = 0;
      try {
        if (orderAttackCandidates(this.st, opponent, 'threats').length === 0) {
          continue;
        }
        const fastFours = orderAttackCandidates(this.st, opponent, 'fours');
        if (fastFours.length > 0) {
          const fastContext: ThreatContext = {
            attacker: opponent,
            mode: 'fours',
            nodes: 0,
            exhausted: false,
            maxNodes: 128,
            now: now ?? undefined,
            deadline: defenseDeadline ?? undefined,
          };
          this.activeContext = fastContext;
          try {
            proof = yield* searchThreatProof(this.st, fastContext, DEFENSE_ATTACK_LIMIT);
          } finally {
            this.activeContext = null;
            nodesUsed += fastContext.nodes;
          }
        }

        if (!proof && (defenseDeadline === null || now!() < defenseDeadline)) {
          const candidateLimit = Math.min(
            DEFENSE_NODE_LIMIT,
            Math.max(32, Math.floor(this.resolved.maxNodes / moves.length)),
          );
          const pnsContext: ThreatContext = {
            attacker: opponent,
            mode: 'threats', // 包含活三威胁
            nodes: 0,
            exhausted: false,
            maxNodes: candidateLimit,
            now: now ?? undefined,
            deadline: defenseDeadline ?? undefined,
          };
          this.activeContext = pnsContext;
          try {
            proof = yield* searchPnProof(this.st, pnsContext, DEFENSE_ATTACK_LIMIT);
          } finally {
            this.activeContext = null;
            nodesUsed += pnsContext.nodes;
          }
        }
      } finally {
        this.doRemove(move, this.me);
        this.vcfNodes += nodesUsed;
      }
      if (!proof || !(yield* verifyProofSteps(this.gameAfterMove(move), opponent, proof))) continue;
      remaining.splice(remaining.indexOf(move), 1);
      // 所有候选均会输时保留正常搜索，让它选择抵抗路线。
      if (remaining.length === 0) {
        this.defendedRootMoves = moves;
        this.bestRoot = moves[0] ?? this.bestRoot;
        return;
      }
      // 预算中断时也不能重新采用已经被证明会送杀的兜底手。
      this.bestRoot = remaining[0] ?? this.bestRoot;
    }
  }

  private gameAfterMove(move: number): GameState {
    const board = this.gameSnapshot.board.map((row) => row.slice());
    const x = move % AI_SIZE;
    const y = Math.floor(move / AI_SIZE);
    const row = board[y];
    if (row) row[x] = this.me;
    return { ...this.gameSnapshot, board, moves: [...this.gameSnapshot.moves, { x, y, c: this.me }] };
  }

  /** 执行算杀：
   * 1. 快速连续冲四（最多 300ms，mode: 'fours'）
   * 2. 最强档执行 PNS 求胜（最多 2000ms / 动态剩余 70%，mode: 'threats'，PNS_ATTACK_LIMIT=8, pnsMaxNodes）
   * 返回获胜首着，无杀返回 -1
   */
  private *runVcf(): Generator<void, number, void> {
    const threats = orderAttackCandidates(this.st, this.me, 'threats');
    if (threats.length === 0) return -1;

    const now = this.resolved.now;
    const current = now !== null ? now() : 0;

    // 阶段 1: 快速连续冲四（仅在有冲四/成五候选时执行）
    const fours = orderAttackCandidates(this.st, this.me, 'fours');
    if (fours.length > 0) {
      const fastLimitMs = now !== null
        ? Math.min(FAST_VCF_TIME_BUDGET_MS, Math.max(0, (this.totalDeadline ?? 0) - current))
        : null;
      const fastDeadline = (now !== null && fastLimitMs !== null) ? current + fastLimitMs : null;

      const fastContext: ThreatContext = {
        attacker: this.me,
        mode: 'fours',
        nodes: 0,
        exhausted: false,
        maxNodes: this.resolved.vcfMaxNodes,
        now: now ?? undefined,
        deadline: fastDeadline ?? undefined,
      };
      this.activeContext = fastContext;
      let fastProof: WinningProof | null = null;
      try {
        fastProof = yield* searchThreatProof(this.st, fastContext, this.vcfDepth);
      } finally {
        this.activeContext = null;
        this.vcfNodes += fastContext.nodes;
      }
      if (fastProof && (yield* verifyProofSteps(this.gameSnapshot, this.me, fastProof))) {
        this.winningProof = fastProof;
        return fastProof.at;
      }
    }

    if (this.difficulty !== 'hard') return -1;
    if (this.stop !== null) return -1;
    const current2 = now !== null ? now() : 0;
    if (now !== null && current2 >= (this.totalDeadline ?? 0)) return -1;

    // 阶段 2: PNS 求胜（最强档）
    const remainingMs = now !== null ? Math.max(0, (this.totalDeadline ?? 0) - current2) : 0;
    const pnsLimitMs = now !== null
      ? Math.min(this.resolved.pnsTimeBudgetMs ?? PNS_TIME_BUDGET_MS, Math.floor(remainingMs * 0.7))
      : null;
    const pnsDeadline = (now !== null && pnsLimitMs !== null) ? current2 + pnsLimitMs : null;

    const pnsContext: ThreatContext = {
      attacker: this.me,
      mode: 'threats',
      nodes: 0,
      exhausted: false,
      maxNodes: now !== null ? this.resolved.pnsMaxNodes : Math.min(this.resolved.pnsMaxNodes, 20000),
      now: now ?? undefined,
      deadline: pnsDeadline ?? undefined,
    };
    this.activeContext = pnsContext;
    let pnsProof: WinningProof | null = null;
    try {
      pnsProof = yield* searchPnProof(this.st, pnsContext, PNS_ATTACK_LIMIT);
    } finally {
      this.activeContext = null;
      this.vcfNodes += pnsContext.nodes;
    }
    if (pnsProof && (yield* verifyProofSteps(this.gameSnapshot, this.me, pnsProof))) {
      this.winningProof = pnsProof;
      return pnsProof.at;
    }

    return -1;
  }

}

/** 创建搜索会话（非法输入返回空会话，不抛异常） */
export function createSearchSession(
  g: GameState,
  color: PlayerColor,
  opts: AiOptions = {},
): AiSession {
  const resolved = resolveOptions(opts);
  if (!isValidInput(g, color)) return new NullSession(resolved.difficulty);
  return new SearchSession(g, color, resolved);
}

/** 一步求解：内部即 createSearchSession + 跑完所有分片 */
export function findBestMove(g: GameState, color: PlayerColor, opts: AiOptions = {}): Point | null {
  const session = createSearchSession(g, color, opts);
  let guard = 0;
  while (session.step()) {
    guard += 1;
    if (guard > 100000) break;
  }
  return session.result();
}
