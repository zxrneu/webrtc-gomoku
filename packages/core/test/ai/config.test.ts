/**
 * 基础层测试：难度参数表、参数合并、Zobrist 确定性、core 零 IO 约束。
 */

import { describe, expect, it } from 'vitest';
import {
  AI_CELLS,
  DEFAULT_SLICE_MS,
  DIFFICULTY_PRESETS,
  HINT_SEARCH_OPTIONS,
  ROOT_BRANCH_LIMIT,
  SEED_HI,
  SEED_LO,
  VCF_DEPTH,
  VCF_NODE_LIMIT,
  FAST_VCF_TIME_BUDGET_MS,
  PNS_TIME_BUDGET_MS,
  PNS_ATTACK_LIMIT,
  PNS_NODE_LIMIT,
  DEFENSE_CHECK_TIME_BUDGET_MS,
  DEFENSE_ATTACK_LIMIT,
  DEFENSE_NODE_LIMIT,
  ZOBRIST,
  branchLimitFor,
  buildZobristTables,
  fromGameState,
  hashBoard,
  idxOf,
  resolveOptions,
  setCellAtIdx,
} from '../../src/index';
import { create, applyMove, BLACK, WHITE } from '../../src/index';

describe('DIFFICULTY_PRESETS（唯一参数来源）', () => {
  it('三档预算/深度与设计文档一致：200/2、500/4、3000/16', () => {
    expect(DIFFICULTY_PRESETS.easy.timeBudgetMs).toBe(200);
    expect(DIFFICULTY_PRESETS.easy.maxDepth).toBe(2);
    expect(DIFFICULTY_PRESETS.normal.timeBudgetMs).toBe(500);
    expect(DIFFICULTY_PRESETS.normal.maxDepth).toBe(4);
    expect(DIFFICULTY_PRESETS.hard.timeBudgetMs).toBe(3000);
    expect(DIFFICULTY_PRESETS.hard.maxDepth).toBe(16);
    expect(DIFFICULTY_PRESETS.hard.maxNodes).toBe(500000);
  });

  it('每档都带 maxNodes 兜底，且随档位递增', () => {
    expect(DIFFICULTY_PRESETS.easy.maxNodes).toBeGreaterThan(0);
    expect(DIFFICULTY_PRESETS.normal.maxNodes).toBeGreaterThan(DIFFICULTY_PRESETS.easy.maxNodes);
    expect(DIFFICULTY_PRESETS.hard.maxNodes).toBeGreaterThan(DIFFICULTY_PRESETS.normal.maxNodes);
  });

  it('参数表整体与每档都是冻结的（只读契约）', () => {
    expect(Object.isFrozen(DIFFICULTY_PRESETS)).toBe(true);
    expect(Object.isFrozen(DIFFICULTY_PRESETS.easy)).toBe(true);
    expect(Object.isFrozen(DIFFICULTY_PRESETS.normal)).toBe(true);
    expect(Object.isFrozen(DIFFICULTY_PRESETS.hard)).toBe(true);
  });

  it('VCF 深度随档位递增，简单档也保留算杀能力', () => {
    expect(VCF_DEPTH.easy).toBeGreaterThan(0);
    expect(VCF_DEPTH.hard).toBeGreaterThan(VCF_DEPTH.normal);
  });

  it('最强档算杀与反杀预算常量配置正确', () => {
    expect(FAST_VCF_TIME_BUDGET_MS).toBe(300);
    expect(VCF_NODE_LIMIT).toBe(24000);
    expect(PNS_TIME_BUDGET_MS).toBe(2000);
    expect(PNS_ATTACK_LIMIT).toBe(8);
    expect(PNS_NODE_LIMIT).toBe(80000);
    expect(DEFENSE_CHECK_TIME_BUDGET_MS).toBe(600);
    expect(DEFENSE_ATTACK_LIMIT).toBe(6);
    expect(DEFENSE_NODE_LIMIT).toBe(512);
  });
});

describe('resolveOptions / branchLimitFor', () => {
  it('缺省档位为 hard，其余字段回落到档位默认值', () => {
    const r = resolveOptions();
    expect(r.difficulty).toBe('hard');
    expect(r.timeBudgetMs).toBe(DIFFICULTY_PRESETS.hard.timeBudgetMs);
    expect(r.maxDepth).toBe(DIFFICULTY_PRESETS.hard.maxDepth);
    expect(r.maxNodes).toBe(DIFFICULTY_PRESETS.hard.maxNodes);
    expect(r.vcfMaxNodes).toBe(24000);
    expect(r.pnsMaxNodes).toBe(80000);
    expect(r.now).toBeNull();
  });

  it('显式字段覆盖档位默认值，now 原样透传', () => {
    const clock = (): number => 42;
    const r = resolveOptions({
      difficulty: 'easy',
      maxDepth: 6,
      vcfMaxNodes: 1234,
      pnsMaxNodes: 5678,
      now: clock,
    });
    expect(r.difficulty).toBe('easy');
    expect(r.maxDepth).toBe(6);
    expect(r.timeBudgetMs).toBe(DIFFICULTY_PRESETS.easy.timeBudgetMs);
    expect(r.vcfMaxNodes).toBe(1234);
    expect(r.pnsMaxNodes).toBe(5678);
    expect(r.now).toBe(clock);
  });

  it('分支上限：浅层 10、深层 6、根 14', () => {
    expect(branchLimitFor(2)).toBe(10);
    expect(branchLimitFor(3)).toBe(10);
    expect(branchLimitFor(4)).toBe(6);
    expect(ROOT_BRANCH_LIMIT).toBe(14);
  });

  it('默认分片时长与 web 侧对齐（32ms）', () => {
    expect(DEFAULT_SLICE_MS).toBe(32);
  });
});

describe('Zobrist（固定种子 => 确定性）', () => {
  it('同种子两次生成的张量完全相同', () => {
    const a = buildZobristTables(SEED_LO, SEED_HI);
    const b = buildZobristTables(SEED_LO, SEED_HI);
    expect(Array.from(a.lo)).toEqual(Array.from(b.lo));
    expect(Array.from(a.hi)).toEqual(Array.from(b.hi));
    expect(a.sideLo).toBe(b.sideLo);
    expect(a.sideHi).toBe(b.sideHi);
  });

  it('不同种子生成不同张量（避免退化）', () => {
    const a = buildZobristTables(SEED_LO, SEED_HI);
    const b = buildZobristTables(SEED_LO + 2, SEED_HI + 2);
    expect(Array.from(a.lo)).not.toEqual(Array.from(b.lo));
  });

  it('整盘哈希对同局面稳定、对不同局面不同', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK);
    applyMove(g, 7, 8, WHITE);
    const h1 = hashBoard(ZOBRIST, fromGameState(g));
    const h2 = hashBoard(ZOBRIST, fromGameState(g));
    expect(h1).toEqual(h2);
    applyMove(g, 8, 8, BLACK);
    const h3 = hashBoard(ZOBRIST, fromGameState(g));
    expect(h3.lo === h1.lo && h3.hi === h1.hi).toBe(false);
  });

  it('哈希对换色敏感（同一格黑白不同）', () => {
    const black = new Int8Array(AI_CELLS);
    const white = new Int8Array(AI_CELLS);
    setCellAtIdx(black, idxOf(3, 4), BLACK);
    setCellAtIdx(white, idxOf(3, 4), WHITE);
    const hb = hashBoard(ZOBRIST, black);
    const hw = hashBoard(ZOBRIST, white);
    expect(hb.lo === hw.lo && hb.hi === hw.hi).toBe(false);
  });
});

describe('core 零 IO / 零随机（架构 §8.1）', () => {
  // 用 Vite 的 raw glob 直接读源码文本，避免 node:fs 的模块加载开销
  const SOURCES = import.meta.glob('../../src/ai/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('src/ai 下不出现 Math.random / Date. / performance. / window.', () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThanOrEqual(10);
    const forbidden = [/Math\.random/, /Date\./, /performance\./, /window\./];
    const hits: string[] = [];
    for (const [name, text] of Object.entries(SOURCES)) {
      for (const re of forbidden) {
        if (re.test(text)) hits.push(`${name}: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });
});


describe('提示的独立分析预算', () => {
  it('提示比最强对手拥有更多时间、节点和搜索深度', () => {
    expect(HINT_SEARCH_OPTIONS.difficulty).toBe('hard');
    expect(HINT_SEARCH_OPTIONS.timeBudgetMs).toBeGreaterThan(DIFFICULTY_PRESETS.hard.timeBudgetMs);
    expect(HINT_SEARCH_OPTIONS.maxNodes).toBeGreaterThan(DIFFICULTY_PRESETS.hard.maxNodes);
    expect(HINT_SEARCH_OPTIONS.maxDepth).toBeGreaterThan(DIFFICULTY_PRESETS.hard.maxDepth);
    expect(HINT_SEARCH_OPTIONS.pnsTimeBudgetMs).toBeGreaterThan(PNS_TIME_BUDGET_MS);
    expect(HINT_SEARCH_OPTIONS.pnsMaxNodes).toBeGreaterThan(PNS_NODE_LIMIT);
  });

  it('提示配置不可修改，且不改变对手的最强档', () => {
    expect(Object.isFrozen(HINT_SEARCH_OPTIONS)).toBe(true);
    expect(DIFFICULTY_PRESETS.hard.timeBudgetMs).toBe(3000);
    expect(DIFFICULTY_PRESETS.hard.maxNodes).toBe(500000);
  });
});
