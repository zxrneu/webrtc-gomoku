/**
 * AI 引擎对外门面。
 *
 * web 层只允许从这里 import（禁止深引 search.ts / pattern.ts），
 * 保证 core 内部结构可重构而对外契约稳定（tasks.md §2）。
 */

export type {
  AiBoard,
  AiOptions,
  AiSearchStats,
  AiSession,
  CutoffReason,
  Difficulty,
} from './types';
export {
  AI_CELLS,
  AI_SIZE,
  CENTER_IDX,
  asPlayer,
  cellAt,
  cellAtIdx,
  fromGameState,
  idxOf,
  oppositeOf,
  setCellAtIdx,
  toPoint,
  xOf,
  yOf,
} from './types';

export type { AiPreset, ResolvedOptions } from './config';
export {
  DEFAULT_SLICE_MS,
  DEFENSE_WEIGHT,
  DIFFICULTY_PRESETS,
  HINT_SEARCH_OPTIONS,
  DEEP_BRANCH_LIMIT,
  ORDER_DEFENSE_WEIGHT,
  ROOT_BRANCH_LIMIT,
  SHALLOW_BRANCH_LIMIT,
  SHALLOW_DEPTH,
  VCF_DEPTH,
  VCF_NODE_LIMIT,
  FAST_VCF_TIME_BUDGET_MS,
  PNS_TIME_BUDGET_MS,
  PNS_ATTACK_LIMIT,
  PNS_NODE_LIMIT,
  DEFENSE_CHECK_TIME_BUDGET_MS,
  DEFENSE_ATTACK_LIMIT,
  DEFENSE_NODE_LIMIT,
  THREAT_NODE_LIMIT,
  THREAT_DEPTH,
  DEFENSE_VCF_NODE_LIMIT,
  DEFENSE_VCF_DEPTH,
  branchLimitFor,
  resolveOptions,
} from './config';

export type { PatternEntry, PatternType } from './pattern';
export {
  COMBO_DOUBLE_FOUR,
  COMBO_DOUBLE_THREE,
  COMBO_FOUR_THREE,
  PATTERN_SCORES,
  PATTERN_TABLE,
  combineScores,
  patternAt,
  patternOfWindow,
  pointScore,
  scoreToPattern,
  windowCode,
  windowScoreAt,
} from './pattern';

export type { PositionState } from './evaluate';
export {
  MATE_SCORE,
  createPositionState,
  evalFor,
  evaluateBoard,
  placeStone,
  pointScoreOf,
  removeStone,
} from './evaluate';

export type { Candidate } from './movegen';
export { collectCandidates, findFivePoints, generateMoves } from './movegen';

export type { TtEntry, TranspositionTable } from './tt';
export {
  DEFAULT_TT_BITS,
  FLAG_EXACT,
  FLAG_LOWER,
  FLAG_UPPER,
  createTranspositionTable,
} from './tt';

export { SEED_HI, SEED_LO, ZOBRIST, buildZobristTables, hashBoard } from './zobrist';

export { openingMove } from './opening';

export { SearchSession, createSearchSession, findBestMove } from './search';
export { createWasmSearchSession } from './wasm/session';
export type { PositionScoring } from './scoring';

export type { WinningProof } from './proof';
export { verifyWinningProof } from './proof';
export type { ProofOptions, ProofResult, ProofSession } from './proofSearch';
export { createProofSession } from './proofSearch';
export type { StrategyCertificate, WinningStrategy } from './strategy';
export { loadWinningStrategy } from './strategy';

export { searchPnProof } from './pnSearch';

export type { Threat } from './dependency';
export { analyzeThreats, orderAttackCandidates, threatDependsOn } from './dependency';
