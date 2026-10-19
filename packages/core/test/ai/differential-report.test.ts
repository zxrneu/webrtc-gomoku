import { describe, expect, it } from 'vitest';
import { verificationStatus, renderDifferentialReport } from '../../../../scripts/lib/differential-report';

const run = { bestMove: 112, bestScore: 20, nodes: 15, elapsedMs: 1 };
const tier = { name: 'truth table', samples: 19683, discrepancies: 0 };

describe('差分报告来自实际结果', () => {
  it('相同落点但节点数不同时仍判定差分失败', () => {
    const comparison = { name: 'fixture', depth: 2, ts: run, wasm: { ...run, nodes: 16 } };
    expect(verificationStatus([tier], [comparison]).passed).toBe(false);
  });

  it('评分或落点漂移不能生成整体通过报告', () => {
    const comparison = { name: 'fixture', depth: 2, ts: run, wasm: { ...run, bestScore: 21 } };
    const markdown = renderDifferentialReport({
      generatedAt: '2026-10-19', platform: 'test', tiers: [tier], comparisons: [comparison], production: [],
    });
    expect(markdown).toContain('**FAIL**');
    expect(markdown).toContain('19683');
    expect(markdown).not.toContain('100% IDENTICAL');
  });

  it('未运行验证或空样本不能报告通过', () => {
    expect(verificationStatus([], []).passed).toBe(false);
    expect(verificationStatus([{ ...tier, samples: 0 }], []).passed).toBe(false);
  });

  it('全量结果一致才通过并区分生产引擎与原型测量', () => {
    const comparisons = [{ name: 'fixture', depth: 2, ts: run, wasm: run }];
    expect(verificationStatus([tier], comparisons).passed).toBe(true);
    const report = renderDifferentialReport({
      generatedAt: '2026-10-19', platform: 'test', tiers: [tier], comparisons,
      production: [{ name: 'real session', move: [7, 7], nodes: 100, depth: 4, elapsedMs: 10, cutoff: 'nodes', budgetMs: 3000 }],
    });
    expect(report).toContain('**PASS**');
    expect(report).toContain('real session');
    expect(report).toContain('生产 TS');
    expect(report).toContain('原型');
  });
});
