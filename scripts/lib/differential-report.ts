/** Pure report aggregation. The CLI owns IO and failure exit codes. */
export interface VerificationTier {
  name: string;
  samples: number;
  discrepancies: number;
}
interface Run {
  bestMove: number;
  bestScore: number;
  nodes: number;
  elapsedMs: number;
}
export interface Comparison {
  name: string;
  depth: number;
  ts: Run;
  wasm: Run;
}
export interface ProductionRun {
  name: string;
  move: readonly number[] | null;
  depth: number;
  nodes: number;
  elapsedMs: number;
  cutoff: string;
  budgetMs: number;
}
export interface DifferentialReport {
  generatedAt: string;
  platform: string;
  tiers: readonly VerificationTier[];
  comparisons: readonly Comparison[];
  production: readonly ProductionRun[];
}

function identical(comparison: Comparison): boolean {
  const { ts, wasm } = comparison;
  return Number.isFinite(ts.bestScore) && Number.isFinite(wasm.bestScore) &&
    ts.bestMove === wasm.bestMove && ts.bestScore === wasm.bestScore && ts.nodes === wasm.nodes;
}

export function verificationStatus(tiers: readonly VerificationTier[], comparisons: readonly Comparison[]) {
  const mismatches = comparisons.filter((row) => !identical(row)).length;
  const validTiers = tiers.length > 0 && tiers.every((tier) =>
    Number.isSafeInteger(tier.samples) && tier.samples > 0 && tier.discrepancies === 0);
  return { passed: validTiers && comparisons.length > 0 && mismatches === 0, mismatches };
}

function nps(run: { nodes: number; elapsedMs: number }): number {
  return run.elapsedMs > 0 ? Math.round(run.nodes * 1000 / run.elapsedMs) : 0;
}

export function renderDifferentialReport(data: DifferentialReport): string {
  const status = verificationStatus(data.tiers, data.comparisons);
  const rows = data.comparisons.map((row) =>
    `| ${row.name} | ${row.depth} | ${row.ts.nodes}/${row.wasm.nodes} | ${nps(row.ts)} | ${nps(row.wasm)} | ${identical(row) ? 'PASS' : 'FAIL'} |`);
  return `# TS / Rust-WASM 差分与性能实测

- 时间：${data.generatedAt}
- 环境：${data.platform}
- 本次验证：**${status.passed ? 'PASS' : 'FAIL'}**；搜索差分失败 ${status.mismatches}/${data.comparisons.length}

## 验证结果

| 项目 | 实际样本数 | 差异/错误数 | 状态 |
|---|---:|---:|---|
${data.tiers.map((tier) => `| ${tier.name} | ${tier.samples} | ${tier.discrepancies} | ${tier.samples > 0 && tier.discrepancies === 0 ? 'PASS' : 'FAIL'} |`).join('\n')}

## 固定深度原型：TS 与独立 Rust 搜索

两端使用相同候选排序、深度、分支数和节点预算。Rust 端独立执行递归、强制防守和叶点评估。
以下 NPS 仅用于同策略原型比较，不能解释为生产最强档的加速比。

| 局面 | 深度 | TS/Rust 节点 | TS NPS | Rust NPS | 落点/分数/节点一致 |
|---|---:|---:|---:|---:|---|
${rows.join('\n')}

## 生产 TS 引擎实测

直接调用 createSearchSession（hard），保留开局、VCF/PNS、反杀和 Alpha-Beta 流程。
生产引擎和固定深度原型策略不同，因此分别报告，不把节点吞吐差异当作棋力或速度提升。

| 局面 | 落点 | 完成深度 | 节点 | 耗时 ms | 预算 ms | NPS | 结束原因 |
|---|---|---:|---:|---:|---:|---:|---|
${data.production.map((row) => `| ${row.name} | ${row.move?.join(',') ?? 'null'} | ${row.depth} | ${row.nodes} | ${row.elapsedMs.toFixed(2)} | ${row.budgetMs} | ${nps(row)} | ${row.cutoff} |`).join('\n')}

该报告只记录本次执行的样本与测量；未测量 GC、分配次数、完整棋力或生产可用性，不据此声明零分配或生产就绪。
`;
}
