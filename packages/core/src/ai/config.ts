/**
 * 棋力参数的唯一来源（架构 §8.2）：预算 / 深度 / 分支 / 权重全部集中在此，
 * 调用点与 UI 只允许传 Difficulty，禁止出现魔数。
 */

import type { AiOptions, Difficulty, ResolvedOptions } from './types';
export type { ResolvedOptions } from './types';

/** 一档难度的完整参数（不含 difficulty / now 本身） */
export type AiPreset = Readonly<Required<Pick<AiOptions, 'timeBudgetMs' | 'maxDepth' | 'maxNodes'>>>;

/**
 * 三档参数表。
 * timeBudgetMs 只在注入了 now 时生效；无 now 时由 maxNodes 兜底收敛，
 * 这样单测可以在毫秒级完成且完全确定。
 */
export const DIFFICULTY_PRESETS: Readonly<Record<Difficulty, AiPreset>> = Object.freeze({
  easy: Object.freeze({ timeBudgetMs: 200, maxDepth: 2, maxNodes: 4000 }),
  normal: Object.freeze({ timeBudgetMs: 500, maxDepth: 4, maxNodes: 20000 }),
  hard: Object.freeze({ timeBudgetMs: 3000, maxDepth: 16, maxNodes: 500000 }),
});

/** 玩家主动请求的深度提示；不改变对手档位，也不改变可取消分片的调度方式。 */
export const HINT_SEARCH_OPTIONS = Object.freeze({
  difficulty: 'hard',
  timeBudgetMs: 10000,
  maxDepth: 24,
  maxNodes: 2000000,
  vcfMaxNodes: 96000,
  pnsMaxNodes: 320000,
  pnsTimeBudgetMs: 6000,
} satisfies AiOptions);

/** 根节点分支上限 */
export const ROOT_BRANCH_LIMIT = 14;

/** 浅层（depth <= SHALLOW_DEPTH）分支上限 */
export const SHALLOW_BRANCH_LIMIT = 10;

/** 深层分支上限 */
export const DEEP_BRANCH_LIMIT = 6;

/** 浅/深分支的分界深度 */
export const SHALLOW_DEPTH = 3;

/** 局面评估的防守权重（略偏堵） */
export const DEFENSE_WEIGHT = 1.1;

/** 走法排序的防守权重 */
export const ORDER_DEFENSE_WEIGHT = 0.9;

/** 默认分片时长（毫秒），与 web 侧 sliceMs 对齐 */
export const DEFAULT_SLICE_MS = 32;

/** 快速冲四算杀时间预算（毫秒）与节点上限 */
export const FAST_VCF_TIME_BUDGET_MS = 300;
export const VCF_NODE_LIMIT = 24000;

/** 各档位的 VCF 深度（以「我方冲四次数」计） */
export const VCF_DEPTH: Readonly<Record<Difficulty, number>> = Object.freeze({
  easy: 2,
  normal: 6,
  hard: 10,
});

/** PNS 求胜时间预算（毫秒）与节点/进攻上限 */
export const PNS_TIME_BUDGET_MS = 2000;
export const PNS_ATTACK_LIMIT = 8;
export const PNS_NODE_LIMIT = 80000;

/** 困难档连续威胁搜索（兼容别名） */
export const THREAT_NODE_LIMIT = PNS_NODE_LIMIT;
export const THREAT_DEPTH = PNS_ATTACK_LIMIT;

/** 根候选反杀检查总时间预算（毫秒）与单候选限制 */
export const DEFENSE_CHECK_TIME_BUDGET_MS = 600;
export const DEFENSE_ATTACK_LIMIT = 6;
export const DEFENSE_NODE_LIMIT = 512;

/** 最强档反杀检查参数（兼容别名） */
export const DEFENSE_VCF_NODE_LIMIT = DEFENSE_NODE_LIMIT;
export const DEFENSE_VCF_DEPTH = DEFENSE_ATTACK_LIMIT;

/** 每隔多少个节点检查一次时间（时间函数调用开销大，必须降频） */
export const NODE_TIME_CHECK_MASK = 255;

/** 按剩余深度取分支上限 */
export function branchLimitFor(depth: number): number {
  return depth <= SHALLOW_DEPTH ? SHALLOW_BRANCH_LIMIT : DEEP_BRANCH_LIMIT;
}

/** 合并调用方参数与档位默认值 */
export function resolveOptions(opts: AiOptions = {}): ResolvedOptions {
  const difficulty = opts.difficulty ?? 'hard';
  const preset = DIFFICULTY_PRESETS[difficulty];
  return {
    difficulty,
    timeBudgetMs: opts.timeBudgetMs ?? preset.timeBudgetMs,
    maxDepth: opts.maxDepth ?? preset.maxDepth,
    maxNodes: opts.maxNodes ?? preset.maxNodes,
    vcfMaxNodes: opts.vcfMaxNodes ?? VCF_NODE_LIMIT,
    pnsMaxNodes: opts.pnsMaxNodes ?? PNS_NODE_LIMIT,
    pnsTimeBudgetMs: opts.pnsTimeBudgetMs,
    now: opts.now ?? null,
  };
}
