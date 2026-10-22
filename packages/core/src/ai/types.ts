/**
 * AI 引擎的纯类型定义 + 内部棋盘原语。
 *
 * 为什么把 `cellAt/idxOf` 等原语放在这里：所有 ai 子模块都依赖它们，
 * 集中在唯一的类型文件里可以避免循环依赖，并且保证 `noUncheckedIndexedAccess`
 * 下只有这一处触碰 `Int8Array`（架构 §9 R3）。
 * 另外本文件只从 `../index` 做 `import type`，不引入任何运行时依赖，
 * 因此 `index.ts -> ai/index.ts -> ai/types.ts` 不构成运行时循环。
 */

import type { Color, GameState, PlayerColor, Point } from '../index';
import type { WinningProof } from './proof';

// 把 core 的公共类型再透出一份，供 ai 子模块统一从 './types' 取用，
// 避免各模块各自 import '../index' 造成的路径散落。
export type { Color, GameState, Move, PlayerColor, Point } from '../index';

/** 棋盘边长，与 GameState.size 保持一致（独立常量以切断运行时循环依赖） */
export const AI_SIZE = 15;

/** 棋盘格数 15 × 15 */
export const AI_CELLS = AI_SIZE * AI_SIZE;

/** 天元（中心点）的线性索引 */
export const CENTER_IDX = 7 * AI_SIZE + 7;

/** 黑棋数值常量（与 core 的 BLACK 等价，避免运行时 import） */
export const AI_BLACK = 1;

/** 白棋数值常量（与 core 的 WHITE 等价） */
export const AI_WHITE = 2;

/** 4 个探测方向：横 / 竖 / 主对角 / 副对角 */
export const AI_DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

/** 内部棋盘：长度 225 的 Int8Array，索引 = y * 15 + x，值 0/1/2 */
export type AiBoard = Int8Array;

/** 难度档位 */
export type Difficulty = 'easy' | 'normal' | 'hard';

/** 搜索参数；未提供的字段回落到 DIFFICULTY_PRESETS */
export interface AiOptions {
  /** 浏览器评分后端偏好；不可用时允许回退 TS。 */
  backend?: 'ts' | 'rust-wasm';
  /** 档位，默认 'hard'；仅决定下面三个字段的默认值 */
  difficulty?: Difficulty;
  /** 思考预算（毫秒）。仅在传入 now 时生效 */
  timeBudgetMs?: number;
  /** 搜索深度上限（层） */
  maxDepth?: number;
  /** 节点预算。未传 now 时用此值兜底，保证无时间源也能终止 */
  maxNodes?: number;
  /** VCF 冲四算杀节点上限（解耦于常规 maxNodes） */
  vcfMaxNodes?: number;
  /** PNS 威胁算杀节点上限（解耦于常规 maxNodes） */
  pnsMaxNodes?: number;
  /** PNS 威胁算杀时间预算（毫秒） */
  pnsTimeBudgetMs?: number;
  /** 时间源注入。core 禁止直读 Date/performance；不传 = 纯节点预算模式 */
  now?: () => number;
}

/** 归一化后的搜索参数（架构 R2：战术算杀算力解耦） */
export interface ResolvedOptions {
  readonly difficulty: Difficulty;
  readonly timeBudgetMs: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly vcfMaxNodes: number;
  readonly pnsMaxNodes: number;
  readonly pnsTimeBudgetMs?: number;
  readonly now: (() => number) | null;
}

/** 搜索终止原因 */
export type CutoffReason = 'time' | 'nodes' | 'depth' | 'aborted' | 'none';

/** 搜索统计快照 */
export interface AiSearchStats {
  /** 实际评分后端；不表示整个搜索或证明过程都在该语言中执行。 */
  backend?: 'ts' | 'rust-wasm';
  /** 只有独立规则检查器认可证书后才为 win；高估分不是证明 */
  proofStatus?: 'win' | 'unknown';
  winningProof?: WinningProof;
  /** 已完成的迭代加深层数 */
  depth: number;
  /** 访问节点数（含算杀节点） */
  nodes: number;
  /** 由注入的 now 计算；无 now 时恒为 0 */
  elapsedMs: number;
  /** 终止原因 */
  cutoff: CutoffReason;
  /** 根节点分数（negamax 视角，正数=当前行棋方优） */
  bestScore: number;
  /** 是否命中开局策略 */
  fromOpening: boolean;
}

/** 可增量推进的搜索会话 */
export interface AiSession {
  /** 档位（只读） */
  readonly difficulty: Difficulty;
  /** 推进一片工作；返回 true 表示还有剩余工作需继续调用 */
  step(budgetMs?: number): boolean;
  /** 当前最优解（预算不足一层时返回合法兜底点；非法/终局返回 null） */
  result(): Point | null;
  /** 统计快照 */
  stats(): AiSearchStats;
  /** 放弃搜索，此后 result() 返回已完成层的最优解 */
  abort(): void;
}

/** 坐标转线性索引 */
export function idxOf(x: number, y: number): number {
  return y * AI_SIZE + x;
}

/** 线性索引转横坐标 */
export function xOf(idx: number): number {
  return idx % AI_SIZE;
}

/** 线性索引转纵坐标 */
export function yOf(idx: number): number {
  return Math.floor(idx / AI_SIZE);
}

/** 越界安全的格子读取；越界返回 EMPTY(0) */
export function cellAt(b: AiBoard, x: number, y: number): Color {
  if (x < 0 || y < 0 || x >= AI_SIZE || y >= AI_SIZE) return 0;
  return cellAtIdx(b, idxOf(x, y));
}

/** 越界安全的按索引读取（`cellAt` 的索引版本，同属唯一封装族） */
export function cellAtIdx(b: AiBoard, idx: number): Color {
  if (idx < 0 || idx >= AI_CELLS) return 0;
  const v = b[idx] ?? 0;
  return v === AI_BLACK ? 1 : v === AI_WHITE ? 2 : 0;
}

/** 越界安全的按索引写入 */
export function setCellAtIdx(b: AiBoard, idx: number, color: Color): void {
  if (idx < 0 || idx >= AI_CELLS) return;
  b[idx] = color;
}

/** 把公开的 GameState 转成内部棋盘（唯一转换点，防双份真值漂移） */
export function fromGameState(g: GameState): AiBoard {
  const board = new Int8Array(AI_CELLS);
  for (const m of g.moves) {
    if (m.x < 0 || m.y < 0 || m.x >= AI_SIZE || m.y >= AI_SIZE) continue;
    setCellAtIdx(board, idxOf(m.x, m.y), m.c);
  }
  return board;
}

/** 线性索引转公开坐标元组 */
export function toPoint(idx: number): Point {
  return [xOf(idx), yOf(idx)];
}

/** 取对手颜色 */
export function oppositeOf(c: PlayerColor): PlayerColor {
  return c === AI_BLACK ? AI_WHITE : AI_BLACK;
}

/** 把非空 Color 收窄成 PlayerColor（调用方需保证 c !== 0） */
export function asPlayer(c: Color): PlayerColor {
  return c === AI_WHITE ? AI_WHITE : AI_BLACK;
}
