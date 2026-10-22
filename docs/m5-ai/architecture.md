# 人机对战 · 当前架构（M5 · AI Opponent）

核对日期：2026-10-22。本文描述当前实现，替代初版「逐字照写」的接口草案。产品需求见 [PRD](prd.md)，能力边界与证书命令见[引擎说明](engine-upgrade.md)。公开 API 和参数以源码为准，性能目标不等同于已测结果。

## 1. 算法与数据流

浏览器对局使用 TypeScript 引擎：开局策略 → 快速连续冲四（VCF）→ 困难档证明数搜索（PNS）→ 根候选反杀检查 → Negamax / Alpha-Beta、置换表与迭代加深。找到并复验必胜证书后可提前结束；否则在时间、深度或节点预算耗尽时返回当前结果。

内部棋盘为 `Int8Array(225)`，索引为 `y * 15 + x`。`fromGameState` 从棋谱重建搜索棋盘；搜索内部配对落子与回退，避免修改 UI 棋局。Zobrist 使用固定种子，候选排序有确定的平局顺序。

棋型识别由 [pattern.ts](../../packages/core/src/ai/pattern.ts) 的 `PATTERN_TABLE` 生成三进制窗口评分查找表，热路径通过数字编码查表；字符串版 `patternOfWindow` 用于交叉验证。它不是旧设计中的每节点字符串扫描或 `PATTERNS` 常量。评估保存方向分、单点分与假设落子缓存，落子/回退时更新或失效受影响位置。

## 2. 模块职责

| 模块 | 当前职责 |
| --- | --- |
| [types.ts](../../packages/core/src/ai/types.ts) | `AiOptions`、`AiSession`、统计类型、内部棋盘转换与安全访问 |
| [config.ts](../../packages/core/src/ai/config.ts) | 难度、提示、搜索阶段与分支限制的默认参数 |
| [pattern.ts](../../packages/core/src/ai/pattern.ts) / [evaluate.ts](../../packages/core/src/ai/evaluate.ts) | 棋型查表、组合威胁与增量评估 |
| [movegen.ts](../../packages/core/src/ai/movegen.ts) | 邻域候选、排序、强制成五/防守与分支裁剪 |
| [search.ts](../../packages/core/src/ai/search.ts) | 可暂停搜索会话、阶段编排、预算检查与结果提交 |
| [dependency.ts](../../packages/core/src/ai/dependency.ts) / [pnSearch.ts](../../packages/core/src/ai/pnSearch.ts) | 威胁分析、候选排序与有限预算 PNS |
| [proofSearch.ts](../../packages/core/src/ai/proofSearch.ts) / [proof.ts](../../packages/core/src/ai/proof.ts) | 离线求解与独立规则复验 |
| [strategy.ts](../../packages/core/src/ai/strategy.ts) | 载入证书并沿对手实际应手复用已验证策略 |
| [AI 门面](../../packages/core/src/ai/index.ts) | 导出搜索、评估、配置、证明与棋盘原语 |
| [aiGame.ts](../../packages/web/src/ai/aiGame.ts) / [useAiGame.ts](../../packages/web/src/ai/useAiGame.ts) | 纯棋局操作与 React 回合编排 |
| [aiSearch.ts](../../packages/web/src/ai/aiSearch.ts) / [workerClient.ts](../../packages/web/src/ai/workerClient.ts) | 创建内联 Worker、请求 ID 隔离、取消和失败回退 |
| [workerRuntime.ts](../../packages/web/src/ai/workerRuntime.ts) | Worker 请求编排、搜索驱动和已验证策略复用 |
| [searchDriver.ts](../../packages/web/src/ai/searchDriver.ts) | 可注入时间源与调度器的分片搜索驱动 |
| [aiHint.ts](../../packages/web/src/ai/aiHint.ts) / [useAiHint.ts](../../packages/web/src/ai/useAiHint.ts) | 独立提示搜索及结果展示，不自动落子 |

## 3. API 与会话语义

主要入口仍为 `findBestMove(g, color, opts?)`、`createSearchSession(g, color, opts?)`、`openingMove(g, color)` 和 `evaluateBoard(g, me)`。完整签名见 [types.ts](../../packages/core/src/ai/types.ts)和[门面](../../packages/core/src/ai/index.ts)，避免在文档复制一份容易失效的类型声明。

`AiOptions` 包含 `difficulty`、`timeBudgetMs`、`maxDepth`、`maxNodes`、`vcfMaxNodes`、`pnsMaxNodes`、`pnsTimeBudgetMs` 和 `now`。常规节点预算与 VCF/PNS 节点预算独立。

- `step(budgetMs?)` 返回 `true` 表示还有工作；生成器保留未完成候选和递归进度，下一片继续。
- `result()` 返回已提交的最优点；未完成任何深度时已有合法候选兜底，`depth` 可以为 0。非法输入或终局返回 `null`，不能把深度 0 等同于无结果。
- `abort()` 终止搜索，保留已有结果；web 调度器取消后不调用完成回调。
- `stats()` 包括深度、总节点、耗时、结束原因、分数、开局命中和可选证明信息。当前没有 `phaseMs`、`slices` 或 `sliceOverheadMs` 字段。
- 未注入 `now` 时不检查墙钟，`elapsedMs` 为 0，由节点/深度限制收敛；固定局面与节点预算适合确定性测试。注入真实时钟后的结果可能随设备和调度变化。
- 时间与分片限制通过协作式检查实现，初始化、阶段收尾和调度仍有开销，不承诺严格的墙钟上限或旧设计中的 `budget × 1.05`。

## 4. 当前默认预算

| 场景 | 总预算 ms | 常规深度上限 | 常规节点上限 |
| --- | ---: | ---: | ---: |
| 简单 | 200 | 2 | 4000 |
| 普通 | 500 | 4 | 20000 |
| 最强 | 3000 | 16 | 500000 |
| 玩家提示 | 10000 | 24 | 2000000 |

参数来自 [config.ts](../../packages/core/src/ai/config.ts)。时间预算需有 `now`；web 驱动默认注入 `performance.now()`。开局、找到证明、深度或节点上限均可使搜索提前结束。

最强档快速 VCF 最多 300ms、24000 节点；PNS 默认最多 2000ms，且不超过开始该阶段时剩余总时间的 70%，最多 8 次进攻、80000 节点。无时钟时 PNS 节点最多 20000。根候选反杀检查最多 600ms，每个候选最多 6 次进攻、512 节点，根分支上限 14。阶段预算受总预算约束，不能相加当作额外时长。

提示独立提高 VCF 节点到 96000、PNS 节点到 320000、PNS 阶段上限到 6000ms，仍受剩余时间比例限制。它不改变对手的难度设置。

## 5. 浏览器执行与取消

默认路径是 `useAiGame → runAiSearch → workerClient → search.worker → workerRuntime → runSearchSharded → AiSession`。Worker 以 Blob 内联在单文件中，无需额外脚本请求；没有 Worker、创建失败、响应异常或返回非法落点时回退主线程分片。注入测试用时间源或调度器时也直接使用回退路径。

Worker 默认每片 **250ms**，主线程回退默认每片 **32ms**。两者共用可取消的搜索驱动；Worker 以请求 ID 丢弃旧响应，取消消息需等当前计算片让出后处理，不能视为抢占式中断。

主线程负责棋盘渲染、thinking 和落子提交。驱动首片也经调度器让出，给予 UI 渲染机会；单片设置并不构成所有设备上的 longtask=0 保证，仍需浏览器测量。切模式、重开、取消后，旧搜索结果不能覆盖当前棋局。

## 6. 求胜证明与 WASM 边界

`proofStatus='win'` 只在独立规则检查器认可当前局面的完整证书后使用；高估分或搜索深度不是证明。`unknown` 表示没有找到完整证明，不能解释为必败、和棋或不败保证。具体证书结构与离线命令见[引擎说明](engine-upgrade.md)。

仓库已有[独立 Rust/WASM 内核](../../crates/gomoku-kernel/src/lib.rs)、[包装器](../../packages/core/src/ai/wasm/kernel.ts)与[差分台架](../../scripts/ai-differential-bench.mjs)。它们尚未接入生产 `createSearchSession`。固定深度原型的 NPS 不能解释为浏览器最强档加速比，也不能代表完整棋力等价。

## 7. 验证方式

从仓库根运行：

```sh
pnpm build && pnpm test
pnpm exec vitest run packages/core/test/ai packages/web/test/ai-driver.test.ts packages/web/test/ai-worker.test.ts
pnpm ai:bench --positions=5 --seed=7 --budget=3000 --difficulty=hard --json
pnpm ai:verify docs/m5-ai/examples/double-three.proof.json
```

Worker、预算中断、分片恢复、战术题、证书复验分别由对应测试覆盖。修改 web 后还需按[测试说明](../testing.md)运行浏览器回归；台架和历史报告仅证明其明确记录的样本与环境。
