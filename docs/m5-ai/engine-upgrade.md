# AI 引擎升级与能力边界

## 原生 Rust 证明求解

新增独立的 [gomoku-solver](../../crates/gomoku-solver/README.md)，提供全盘候选的增量证明数搜索、精确局面置换复用、攻击方对称归并、DAG 胜法证书、独立检查器、策略执行和离线断点恢复。支持导入现有 TypeScript 证书，并导出供 TypeScript 独立复验的树格式。使用 `pnpm ai:rust:prove` / `ai:rust:resume` / `ai:rust:verify`。

Rust 链路尚未生成空盘必胜证书，也未接入浏览器对手；它提供可继续求解和复验的原生实现，不构成本项目已经先手必胜的声明。浏览器路径与下述有限预算配置保持一致。

原生 Rust 后续新增连续冲四 / 连续威胁证明、对称证明复用和外部开局数据编译入口。参见 [Rust 求解器说明](../../crates/gomoku-solver/README.md) 与 [成熟实现参考实测](rust-mature-report.json)；当前仍未取得空盘必胜证书。

最新一轮按优先级加入 fucusy 局面到落点提示导入、独立复验的持久证明缓存、可续算的条件任务清单、有限威胁依赖组合、一个安静准备手，以及共享完整候选图的实验性 DFPN。入口为 `ai:rust:import` / `ai:rust:compile` / `ai:rust:work` / `ai:rust:dfpn`。真实样本与续算结果见 [优先级落地报告](rust-priority-report.json)；局部缓存增长仍未形成空盘完整策略。

## 浏览器计算

人机模式通过 `aiSearch.ts → workerClient.ts → search.worker.ts` 启动并复用一个 Web Worker。搜索和策略复验在 Worker 中执行；React、棋盘绘制和交互留在主线程。请求 ID 隔离不同棋局，切模式、重开和取消后不会接收旧结果。

Worker 以 Blob 内联到构建产物，HTTP 页面和直接打开的 `dist/gomoku-standalone.html` 都可离线下棋。Worker 不可用、初始化失败或消息异常时，自动使用可取消的主线程分片搜索。

一个 Worker 使用一个计算线程，主要改善交互响应；当前没有实现多核搜索池。Worker 默认通过 [WASM 会话工厂](../../packages/core/src/ai/wasm/session.ts)将 Rust/WASM 接入增量方向评分和假设落点评分，现有 TypeScript 迭代加深、置换表、VCF/PNS、反杀与证书检查继续执行。每个会话拥有独立 WASM 实例和棋盘，落子/撤子同步两侧状态，WASM 初始化失败时使用 TS；Worker 不可用时继续使用主线程 TS 分片回退。这里接入的是 [gomoku-kernel](../../crates/gomoku-kernel/src/lib.rs)，离线 `gomoku-solver` 保持独立。

默认启用 Rust/WASM 评分；人机界面顶部“引擎”可选 Rust/WASM 或 TS，并本地记忆。切换保留棋盘、取消旧搜索，当前 AI 回合改用新引擎，旧提示清除，后续提示跟随选择。首次打开页面的 `?aiEngine=ts` 或 `?aiEngine=rust-wasm` 优先于已保存选择，页面内选择器可继续修改。`AiOptions.backend` 显式配置优先，Worker 回复的 `stats.backend` 表示实际评分后端；策略证书直接执行与主线程回退使用 TS。页面首载捕获后端偏好，后续大厅路由切换不会丢失选择。WASM 字节码内嵌，无额外网络依赖。生产算法的同预算比较见 [实际搜索接入实测](wasm-production-report.md)，原有 [固定深度差分台架](../../scripts/ai-differential-bench.mjs)仍单独保留。

Worker 默认每片 250ms，主线程回退每片 32ms。分片通过生成器保留递归栈与棋盘，暂停后继续同一个候选。连续冲四搜索也遵守分片；总预算不足一层时返回合法兜底手，完成深度保持为 0。

## 求胜与证明

普通搜索使用迭代加深、Alpha-Beta、置换表和候选裁剪。高估分、开局策略和有限深度都不能证明必胜。`AiSearchStats.proofStatus` 只有两种状态：

- `win`：`winningProof` 已通过独立规则检查器，可以覆盖当前局面所有合法防守应手。
- `unknown`：没有完整证明；不等于必败或和棋。

困难档在连续冲四之外，增加包含活三的有限预算 AND/OR 搜索。攻击方找到一条胜路即可；防守方必须覆盖全部空点，不能只验证邻近候选。证书支持直接成五、两个立即成五点、强制堵四链、完整防守分支。检查器不依赖棋型估分，按 15×15、交替落子、无禁手、五连或长连获胜的规则复验，也拒绝非法棋谱、缺失分支和循环证书。

## 最强档算法升级（威胁依赖分析 + 证明数搜索 PNS）

为进一步增强最强档在复杂中局的攻杀与防守强度，引擎借鉴证明数搜索（PNS）与威胁依赖分析（db_search）算法思想进行了深度升级：

1. **威胁依赖分析（`dependency.ts`）**：
   - 将棋盘进攻点抽象为 `Threat` 结构（包含成形点 `gain`、防守必堵点 `cost`、后续成形空点 `rest` 与既有棋子 `stones`）。
   - 建立了成五、活四、冲四、活三之间的依赖判定（`threatDependsOn`）与冲突检测，用于排列进攻候选与优先检查反击。
   - 启发式候选排序：成五（50000）> 双四/四三（40000）> 冲四（30000/35000）> 活三（20000/25000），配合方向跳过与预筛选，大幅提升评估效率。

2. **证明数搜索（`pnSearch.ts`）**：
   - 攻击方为 OR 节点（$pn = \min(pn_i), dn = \sum dn_i$），防守方为 AND 节点（$pn = \sum pn_i, dn = \min(dn_i)$），按证明数选择最易证明的路径展开。
   - 防守节点覆盖全盘合法防守应手；优先探索冲四必堵点（`cost`/`rest` 赋予高优先级权重），使非必胜攻击分支在 1~2 步内迅速被反驳证伪，极大地压缩了 AND 分支的探索规模。
   - 证明边界严格守住：搜索结果转换为现有 `WinningProof`（`five` / `force` / `branch`），经独立检查器 `verifyWinningProof` 复验通过后方可采用。节点耗尽、深度不足、超时或取消均安全返回 `unknown`，绝不解释为必败。

3. **最强档执行流程与预算分配**：
   - 每步总思考时间预算调整为约 **3000ms**。
   - **流水线**：已验证策略/开局知识 → 快速连续冲四（最多 300ms、24000 节点，mode: `'fours'`）→ PNS 求胜（默认最多 2000ms，且不超过当时剩余预算的 70%；mode: `'threats'`，上限 8 次进攻、80000 节点）→ 根候选反杀防守检查（最多 600ms，每个候选最多 6 次进攻、512 节点，上限 14 手）→ Alpha-Beta (Negamax) 主搜索。无时间源时 PNS 节点另限为最多 20000。
   - 未消耗完的时间预算顺延给后续阶段，证书复验计入预算。
   - 反杀防守检查增加了活三威胁，采用分阶段策略（快速 VCF 先行 + PNS 活三检查），只排除有已验证反杀证书的候选；所有候选均被反杀时保留正常搜索，让 AI 选择最顽强的抵抗路线。

## 执黑与不败承诺的边界

当前引擎没有覆盖空盘全部合法分支的必胜策略库，也没有不败保证。固定天元开局、战术题通过和局部算杀证书，都不能推导对所有对手的胜率。只有对当前局面经过独立复验的完整证书才表示已找到必胜策略；有限预算搜索未找到证书时仍为 `unknown`。

默认最强档为 3000ms、常规深度上限 16、常规节点上限 500000。玩家提示使用独立配置：10000ms、深度 24、常规节点 2000000、VCF 节点 96000、PNS 节点 320000、PNS 阶段预算上限 6000ms。参数以 [config.ts](../../packages/core/src/ai/config.ts)为准；协作式时间检查和浏览器调度会带来墙钟开销，不能把配置预算当成严格耗时上限。

## 离线求解与复验

输入按黑白交替给出坐标，范围为 0–14。`maxAttacks` 计攻击方落子的次数，`maxNodes` 限制搜索节点。时间源由 CLI 注入，core 没有 IO 或全局时钟。

```sh
mkdir -p output
pnpm ai:prove docs/m5-ai/examples/double-three.input.json output/double-three.proof.json
pnpm ai:verify output/double-three.proof.json
```

参数支持 `algorithm: 'dfs' | 'pn'`，默认保留现有 DFS，最强档显式使用 PNS。输出文件必须尚不存在。成功时写入 `gomoku-proof-v1` 证书，退出码为 0；预算不足或未找到证明时写入 `gomoku-search-v1`，退出码为 2；非法输入或复验失败时退出码为 1。示例双活三用 217 个搜索节点得到证明，覆盖 216 个防守应手；对应证书也保存在本目录 `examples/double-three.proof.json`。

搜索模式：`fours` 只找连续冲四，`threats` 包含活三，`complete` 枚举全部攻击点。三种模式都完整验证防守。`complete` 仍受深度、时间、节点预算限制，不代表已经解出空盘。

## 测试

运行 `pnpm build && pnpm test`；浏览器回归先启动 `pnpm start`，再运行 `pnpm test:e2e`。测试覆盖搜索分片、取消与恢复、胜法证书复验、Worker 与离线模式。
