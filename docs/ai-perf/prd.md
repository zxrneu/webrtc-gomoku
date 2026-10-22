# AI 引擎性能优化 PRD（M6 · 纯前端算力 ·「不用服务器，算得更多」）

| 项 | 内容 |
|---|---|
| 语言 | 中文 |
| 编程语言 | 生产搜索为 TypeScript strict；已有独立 Rust/WASM 原型，尚未接入生产 |
| 项目名称 | `gomoku_ai_perf` |
| 作者 | 许清楚（Xu）· 产品经理 |
| 状态 | 历史优化需求；部分已实现，现状与可运行命令见下方说明 |
| 落点 | `docs/ai-perf/prd.md` |
| 原始需求复述 | 「rust 改写 AI 引擎，通过 webassembly 能提速吗？更多计算，不用计算 server 的情况下」→ 在**不增加任何服务端算力**的前提下，让浏览器里跑的 AI 在同一思考时长内**算得更多、下得更强**；Rust+WASM 是候选路线之一，需先证明 TS 侧已无低成本算力可榨。 |

> **现状（2026-10-22）**：下方基线、热点占比、旧源码行号和优化收益为 2026-10-19 的历史记录，不是本次实测。当前最强档为 3000ms / 16 层 / 500000 常规节点，VCF/PNS 节点预算已解耦，默认分别 24000 / 80000，PNS 阶段上限 2000ms；Worker 默认分片 250ms。假设落子缓存和 scratch 缓冲已在实现中，见 [配置](../../packages/core/src/ai/config.ts)、[评估](../../packages/core/src/ai/evaluate.ts)与 [Worker](../../packages/web/src/ai/workerRuntime.ts)。这些实现不自动证明下述吞吐、命中率和所有性能目标达标。

独立 Rust/WASM 原型已提供[差分报告](../m5-ai/differential-benchmark-report.md)，生产 `createSearchSession` 仍为 TypeScript。原型固定深度对比不能代替生产最强档的加速或棋力验收。

当前可运行命令（仓库根目录）：

```sh
pnpm ai:bench --positions=20 --budget=3000 --seed=7 --difficulty=hard --json
pnpm ai:verify docs/m5-ai/examples/double-three.proof.json
mkdir -p output
pnpm bench:differential --positions=10 --budget=3000 --output=output/ai-differential.md
```

`ai:bench` 仅解析 `--positions`、`--seed`、`--budget`、`--difficulty`、`--maxDepth`、`--maxNodes` 和 `--json`。原设想中的 `--suite`、`--report`、`--micro`、`--engine` 未实现，传入会被忽略，不能据此宣称执行了专项验收。当前统计不含 `phaseMs`、`slices` 或 `sliceOverheadMs`；CLI 同步调用 `step(32)`，不测浏览器宏任务空转。`ai:verify` 必须指定证书文件，不是无参数的全题集命令。

---

## 0. 实施前问题快照（历史实测基线，2026-10-19 / Node 22 直跑 core / hard 档 / 3s 预算）

| # | 现象 | 数据 | 产品含义 |
|---|---|---|---|
| F1 | 吞吐不稳，威胁局面塌方 | 常规 25k–38k nps；威胁分析重局面 **4.8k–5.2k nps** | 关键局面反而算得最少，正好是最需要算的局面 |
| F2 | CPU 花在「重复重算」而非「搜索」 | `windowCode` 18.5% + `analyzeThreats` 12.0% + `pointScore` 9.7% + `winsAt` 9.3% + `findWinningPoints` 6.5% ≈ **56%**；generator `yield` 仅 1–2% | 优化对象是棋型/威胁重算，不是搜索框架本身 |
| F3 | 预算空转 | hard 档多数局面 **深度 12 即停**，seed=7 只用 **1.47s / 3s（49%）**；`maxDepth=12`、`maxNodes=60000` 比时间预算更早卡死 | 3s 里有 1.5s 白扔；先把预算用满，收益大于任何微观优化 |
| F4 | 堆常规深度无收益 | `maxDepth=20 / maxNodes=50万` 下深度**仍是 12**，节点 5.5万→13.4万，6 个有效局面**首选手 0 变化** | 禁止把「加层」当目标；算力应投向**算杀/威胁空间** |
| F5 | 工具链未就绪 | `rustc 1.96.1` 已装；`wasm32-unknown-unknown`、`wasm-pack` **未装** | WASM 路线的前置成本尚未计入 |

> 结论：**P0 的价值不在 Rust，而在「把已付的钱花掉」**（F3 + F2）。Rust+WASM 放在最后，且必须先由 P0/P1 给出「TS 侧已榨干」的证据。

---

## 1. 产品目标

**一句话目标**：在**零服务端、单文件 HTML 可离线分发**不变的前提下，让 hard 档把 3s 预算真正用满，并把多出来的算力投到算杀上——使 AI 在**同一思考时长**内搜索产出与必胜捕捉率显著提升，且选点不退化。

### 三个量化目标（部分测量能力尚未实现，不表示已全部可复现）

| # | 指标 | 现状 | 目标 | 口径 |
|---|---|---|---|---|
| **M1** | **预算利用率**（hard 档，20 个固定中局局面，3s 预算） | 49%（seed=7）；`cutoff='depth'` 占比 ≈100% | 有效局面 **≥85%** 的局面 `cutoff='time'`（即时间才是唯一终止原因）；`elapsedMs/3000` **P50 ≥0.85** | `stats().cutoff` 与 `stats().elapsedMs` |
| **M2** | **有效吞吐 nps**（节点数 / 纯搜索耗时，剔除分片空转） | 常规 25k–38k；威胁重 4.8k–5.2k | 常规 **≥60k**；威胁重 **≥12k**（同一 20 局面集合的 P50） | `nodes / (elapsedMs - sliceOverheadMs)` |
| **M3** | **算杀命中率**（固定 28 题算杀集：3 步内 VCF 12 题 + 5–9 步 PNS 16 题） | 基线由 P0-1 首次跑出并冻结为 `baseline.json` | 命中率 **≥90%（≥26/28）**，且单题算杀耗时 **P95 ≤1.8s** | 待实现 killer 题集模式；已有证书可用下方 verify 命令复验 |

**护栏指标（不得退化，任一不过即视为优化失败）**：
- **G1 棋力不回退**：`packages/core/test/ai/bench-tactics.test.ts` 20 题 hard 档仍 **20/20**；`pnpm ai:verify docs/m5-ai/examples/double-three.proof.json` 全绿。
- **G2 选点稳定**：40 个金标准局面（seed 1–40，3s 预算）首选手与冻结快照一致率 **≥95%**（≤2 处变化，且每处变化须人工复核为「不更差」）。
- **G3 不卡顿**：单步 P95 **≤3.5s**、最坏 **≤4.2s**（含调度开销）；浏览器侧 `longtask(>100ms)` 计数 **= 0**。
- **G4 保底不破**：`vite build` 产物仍可单文件离线运行；首屏新增网络请求 **= 0**；gzip 增量 **≤ +40KB**（P0/P1 阶段应为 0）。

---

## 2. 用户故事

| # | 角色 | 故事 | 验收要点 |
|---|---|---|---|
| US-1 | 普通玩家（桌面） | 作为和 hard 档下棋的人，我想 AI 在中局复杂局面也**在 3 秒内**给出更强的应对（尤其别漏杀、别被双威胁打死），以便输得服气、赢得有成就感 | M2 威胁局面 nps ≥12k；M3 算杀命中 ≥90%；G1 20/20 |
| US-2 | 手机端玩家 | 作为用中低端手机打开单文件页面的人，我想 AI 思考时页面**不卡、不烫、不掉电**，以便在微信里点开就能连续下几盘 | G3 longtask=0；单步 P95 ≤3.5s；CPU 占用时长（`performance.now` 累计）不高于当前 |
| US-3 | 开发者 / 维护者 | 作为维护引擎的人，我想每次改完都能用**一条命令**看到「深度 / nps / 各阶段耗时 / 选点是否漂移」，以便判断这次优化到底有没有用、有没有把棋力改坏 | `pnpm ai:bench` 输出对比表 + `baseline.json` 差异；`pnpm build && pnpm test` 全绿 |
| US-4 | 离线使用者 | 作为把 HTML 发给朋友的人，我想优化后仍是**一个文件、零服务器、零请求**，以便继续微信互发 | G4：断网可开局，Network 面板无请求 |

---

## 3. 需求池

### P0（Must have — 没有它就无法判断后续优化是否有效）

| ID | 问题 → 方案方向 | 预期收益 | 成本 | 风险 |
|---|---|---|---|---|
| **P0-1** | **无可观测数据** → 新增 `scripts/ai-bench.mjs`（`pnpm ai:bench`）：固定局面集（seed 化）、固定预算、输出 JSON+表格（depth/nodes/nps/cutoff/elapsed/选点）。`AiSearchStats` 增可选字段：`phaseMs{vcf,pns,negamax}`、`nps`、`slices`、`sliceOverheadMs` | 让 M1/M2/M3 可测；后续每条需求都有 before/after 数字 | 0.5 人日 | 改 core 导出类型 → `workerProtocol` 序列化需同步；字段一律可选以保证向后兼容 |
| **P0-2** | **预算空转（F3）** → 解绑 `maxDepth/maxNodes` 与 3s 时间预算的错配：hard 档以**时间**为唯一终止条件，`maxDepth` 提到 20、`maxNodes` 提到 20 万仅作兜底；新增「每层剩余时间分配」避免最后一层吃不下整层被丢弃 | 3s 利用率 49%→≥85%；深度 12→14+ 的局面占比从 0% 提升到 ≥50% | 1 人日 | 单步耗时可能冲到 3.9s（须保留硬 deadline 兜底）；选点可能漂移（G2 兜） |
| **P0-3** | **worker 内多余分片（F3）** → worker 不阻塞 UI，`sliceMs=32 + setTimeout(0)` 的嵌套钳制（≈4ms）在 3s 内约 **12% 空转**。方向：worker 内改为「按层让出」或 `sliceMs≥300ms`，主线程侧分片策略不变 | 回收 ≈360ms/步 ≈ 多算 1 层；M2 直接受益 | 0.5 人日 | 取消（cancel）响应变慢 → 必须保证 abort 在 ≤1 个让出周期内生效；thinking 心跳需另走消息 |

### P1（Should have — 榨干 TS 侧算力，P0 数据证明方向后再做）

| ID | 问题 → 方案方向 | 预期收益 | 成本 | 风险 |
|---|---|---|---|---|
| **P1-1** | **`generateMoves` 每候选重算 4 方向×9 槽（`movegen.ts:40-68` + `pattern.ts:311`）** → 新增「假设落子分」缓存（`hypoScore[cell*2+color]`），随 `refreshAround` 精确失效；让候选排序变查表 | `windowCode`+`pointScore` 合计 28% 热点中约可砍半；威胁局面 nps 主要受益 | 2–3 人日 | **易算错**：`st.pointScore` 只对已落子格有意义（`evaluate.ts:135-145`，空点恒 0），不能直接复用；缓存失效范围漏一格就是棋力回退 |
| **P1-2** | **`orderAttackCandidates` / `findWinningPoints` 全盘扫 225 格（`dependency.ts:182-230`）** → 只扫 `collectCandidates` 邻域；预计算「每格所在 4 条线」索引，避免每点重建窗口 | `findWinningPoints` 6.5% + `orderAttackCandidates` 3.7% ≈ 砍掉 2/3 | 1.5 人日 | 漏掉远端成五点 → 直接输棋（须有对应用例，AGENTS 铁律 5） |
| **P1-3** | **`analyzeThreats` 每节点分配 `Set`/数组（`dependency.ts:19`，12% 热点）** → 复用 scratch 缓冲（预分配 + 计数器），零分配 | GC 4.2% + 12% 热点下降；威胁局面 nps 提升最明显 | 1.5 人日 | 复用缓冲带来状态串味（递归重入）→ 需按深度分层缓冲 |
| **P1-4** | **算力投向错误（F4）** → 把增量预算给**威胁空间搜索**：`PNS_NODE_LIMIT` 20k→80k、`VCF_NODE_LIMIT` 6k→24k、`PNS_TIME_BUDGET_MS` 1200→2000，并解绑其被 `maxNodes` 夹取的限制（`search.ts:551,585`）；**不加常规深度** | M3 命中率与深度上限提升；F4 已证明这是唯一有效的加算力方向 | 1 人日 | 算杀超时挤占常规搜索 → 必须显式拆「算杀预算 vs 常规预算」，不能共用 `maxNodes` 计数器（`search.ts:217`） |
| **P1-5** | **`windowCode` 18.5% 单点最大热点（`pattern.ts:223-238`）** → 落子时增量维护受影响的窗口码（落一子只影响 ≤4×9 个窗口），把「每节点全量重算」变成「增量更新」 | 若成立可再回收 10%+ | 3 人日 | 增量正确性极难验证 → 必须有「增量 vs 全量」随机差分测试（≥1000 随机局面） |

### P2（Nice to have — 仅在 P0/P1 落地并给出「TS 已榨干」证据后评估）

| ID | 问题 → 方案方向 | 预期收益 | 成本 | 风险 |
|---|---|---|---|---|
| **P2-1** | **Rust + WASM 内核** → 把 `pattern/dependency/movegen/search` 热路径迁 Rust，`wasm-bindgen` 暴露同一 `AiSession` 接口；**双引擎共存**，TS 引擎保留为兜底与对照 | 预期 nps ×2–4（需 P0-1 台架先给 TS 上限作分母） | 8–15 人日（含装 `wasm32-unknown-unknown` + `wasm-pack`） | **破坏单文件保底**（wasm 需 base64 内联，+50–150KB gzip）；**双引擎行为漂移**；维护成本翻倍；构建链从 pnpm 单链变双链 |

---

## 4. 验收标准（每条都必须能跑出来）

| ID | 验收标准 | 阈值 | 测量方法 |
|---|---|---|---|
| P0-1 | 台架可复现 | 同 seed 生成相同局面；真实时间预算下 depth/nodes 可波动，不能要求逐字一致；确定性另用固定节点预算单测验证 | `pnpm ai:bench --positions=20 --budget=3000 --seed=7 --json`（比较局面与统计分布，不直接 diff 耗时/节点） |
| P0-2 | 预算用满 | `cutoff='time'` 占比 ≥85%（20 局面）；`elapsedMs/3000` P50 ≥0.85；深度 ≥14 的局面 ≥50% | 同上，比对 `baseline.json` |
| P0-3 | 空转下降 | `sliceOverheadMs / elapsedMs` **≤3%**（当前 ≈12%） | 待增加分片统计与报告模式；浏览器侧按测试说明采样 longtask |
| P1-1 | 热点下降且棋力不降 | 威胁局面 nps **≥12k**；G1 20/20；G2 一致率 ≥95% | 待实现 threat 题集模式；现有战术回归运行 `pnpm test` |
| P1-2 | 同上 | `findWinningPoints` 单次调用平均耗时 **下降 ≥50%**（台架微基准） | 待实现 findWinningPoints 微基准模式 |
| P1-3 | 分配下降 | 威胁局面 nps **≥15k**；GC 占比 **≤1.5%** | `node --cpu-prof` + 台架 nps |
| P1-4 | 算杀更强 | M3 命中率 **≥90%（26/28）**；算杀耗时 P95 **≤1.8s**；`ai:verify` 全绿 | 待实现 killer 题集模式；证书按下方命令逐个复验 |
| P1-5 | 差分一致 | 随机 1000 局面「增量窗口码 == 全量窗口码」**100% 一致** | `pnpm test`（新增差分用例） |
| P2-1 | 不劣于 TS 且保底不破 | 同预算下 nps **≥ TS 版 ×1.5**，选点一致率 ≥95%；单文件产物 gzip 增量 ≤150KB 且断网可开局 | 独立原型使用 `pnpm bench:differential`；生产 WASM 模式未接入，不能据此验收该目标 |
| 全局 | 交付门禁 | `pnpm build && pnpm test` 全绿；`pnpm ai:verify docs/m5-ai/examples/double-three.proof.json` 全绿 | CI 命令 |

---

## 5. 不做什么（Out of Scope）

1. **不做服务端算力**：不引入远程推理、不新增 API、不用云函数。用户明确要求「不用计算 server」。
2. **不引入需要联网/下载的模型**：不引第三方棋力库、不加载 NN 权重文件（与 P0-11「零重型依赖」一致）。
3. **不破坏单文件零服务器保底**（`ROADMAP.md` 第一原则）：任何优化若导致必须联网取资源、或产物无法单文件离线运行，直接否决。
4. **原 P0 阶段范围**：当时不引入 Rust 构建链；当前已有独立 `crates/gomoku-kernel` 原型。生产搜索接入仍需另外验收。
5. **不做「加常规搜索深度」**：F4 实测首选手 0 变化，明确不作为优化目标。
6. **不改棋规/难度语义**：不改三档定位（easy 仍是弱）、不改 UI 交互与悔棋/重开语义。

---

## 6. 待确认问题（需用户拍板）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| Q1 | hard 档最大思考时长是否可从 **3s 提到 5s**？ | 直接决定 M1 上限；5s 可让「每层时间分配」有更多腾挪空间 | 建议提到 **4s**（手机端可感知上限），并保留 3s 档作为「快速档」 |
| Q2 | 是否接受**首选手在 ≤2 个局面发生变化**（G2 允许 95%）？ | 优化必然带来细微选点漂移；要求 100% 一致等于禁止优化 | 建议接受 ≤2 处，但必须人工复核「不更差」 |
| Q3 | 是否接受 WASM 让单文件体积 **+50–150KB gzip**？ | 决定 P2 是否可能；微信互发场景对体积敏感 | 建议 ≤100KB gzip，超出则 P2 不做 |
| Q4 | 是否要求**中低端手机**也达标（M2 在低端机可能只有桌面 40% nps）？ | 决定指标是「桌面达标」还是「低端机达标」；后者会把 P1 成本翻倍 | 建议 M2 只承诺桌面/近三年机型，低端机只保 G3（不卡） |
| Q5 | 是否接受**双引擎长期共存**的维护成本（TS + Rust 两套实现、两套用例）？ | 决定 P2 的形态：双引擎 or 全量替换 | 建议双引擎，且 Rust 失败可整块删除、TS 路径零改动 |

---

## 附：实施前源码观察（历史行号与约束，不代表当前实现）

1. **算杀预算当前被常规预算夹住**：`search.ts:551` 与 `search.ts:585` 用 `Math.min(VCF_NODE_LIMIT|PNS_NODE_LIMIT, this.resolved.maxNodes)`，且 `stats().nodes` 把 negamax 与算杀节点合并计数（`search.ts:217`）。→ 只调 `PNS_NODE_LIMIT` 无效；「给算杀更多算力」必须**显式拆分两套预算与计数器**。
2. **迭代加深步长为 2，且无每层时间分配**：`search.ts:294`（`currentDepth === 0 ? 2 : currentDepth + 2`）。`maxDepth=12` 实际只有 6 次迭代；解绑后若不做「每层预算分配/放弃整层」策略，第 14 层吃不下仍会回退到 12（F4 已验证）。→ 解绑必须与「层间预算」一起做，单独改参数无效。
3. **`st.pointScore` 不能直接给空点用**：`evaluate.ts:135-145` 里 `pointScore[cell]` 只对**已落子格**有意义（空点恒 0），而 `generateMoves` 需要的是「假设我落在此处」的分（`pattern.ts:307-318` 语义）。→ P1-1 必须新增 `hypoScore` 缓存并在 `refreshAround` 中精确失效，否则会把候选排序算成 0，直接导致棋力塌方。

> 补充（第 4 条，非阻塞）：`workerRuntime.ts:26` 与 `searchDriver.ts:38` 的 `setTimeout(0)` 是取消响应的唯一让出点；P0-3 拉长分片时必须保留「cancel 在 ≤1 个让出周期内生效」这一语义，`packages/web/test/ai-driver.test.ts` 已有 4 个取消用例可作回归。
