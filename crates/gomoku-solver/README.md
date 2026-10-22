# Rust 五子棋证明求解器

原生 Rust 离线求解、独立复验和策略执行，规则固定为 `freestyle-15`：15×15、黑白交替、无禁手、五连或长连获胜。库使用拥有自身棋盘的会话，没有网络、文件、时钟、随机数或可变全局状态；文件和时间预算只在 CLI 中处理。实现不依赖现有 WASM 原型的全局缓冲区，也尚未替换浏览器中的 TypeScript 对手。

**实现了完整搜索与证书链路，但尚未提供空盘必胜证书。当前不能承诺本项目执黑必胜。** 严格验收条件是从空盘生成或导入的证书通过独立检查，并持续沿该策略执行。局部证书、有限预算、对战胜率均不能替代这个条件。

## 算法与证明边界

- 增量 AND/OR 证明数搜索。攻击节点取子节点最小证明数，防守节点累加证明数；按最有希望证明的路径逐步展开。
- 可选连续冲四 / 连续威胁战术证明器。非强制进攻逐点覆盖全盘合法防守，已经找到的证明可以在其他实际防守局面中复验后复用；会检查对方冲四反击，保留防止对方下一手形成双胜点的非进攻落子。
- 排序枚举全盘空点，包括远离已有棋子的点。排序使用局部潜力，仅决定顺序，不按分数或邻域删除合法防守。攻击方仅合并保持双方棋盘完全不变的旋转/反射等价选择；空盘的 225 点有 36 个等价类。防守方仍覆盖每个合法空点。
- 成五、两个立即成五点，以及唯一堵四点由规则提供可靠的分支压缩；检测防守方的立即成五，防止错误证明“活四必胜”。没有这些压缩条件时逐点检查全部防守，包括主动反击和远端落子。
- 置换表按完整棋盘、轮次和剩余攻击预算判等，使用确定性的有序映射，无随机哈希种子，也不以单个哈希值判等。DAG 证书复用已经证明的子图。
- 检查器只读取落子规则和证书，不依赖排序、估分或搜索的证明数。验证缺失/重复防守、非法棋谱、轮次、终局、越界、缺失节点和循环引用；同一 DAG 节点在不同棋盘下分别验证。
- `maxAttacks` 限制搜索中的攻击层数，`fork` 等规则终点压缩了末尾必然获胜的落子。默认 113 足以覆盖空盘的整盘棋；较小预算可能遗漏更长胜法。
- 搜索有限预算耗尽或在给定深度内未找到胜法，都返回 `unknown`，不输出必败/和棋结论。未证明的估分走法不会进入策略执行器。

完整搜索是有限状态空间上的完备后备机制，不代表搜索能在合理时间内从空盘完成。另有开局数据引导的选择性策略编译器：先尝试连续冲四，再以较小战术深度寻找证明，逐步扩大。有限预算的威胁依赖图记录进攻点与防点，组合没有进攻点/防点冲突、能共同产生新威胁的计划；同时填入多个防点的虚拟棋盘只生成候选计划，所有实际应手仍由普通搜索与独立检查器复验。这个规划器尚不等于 Victoria 的完整实现，选择性编译也不具备完整搜索的完备性。

本轮[实测报告](../../docs/m5-ai/rust-solver-report.json)：空盘展开 200000 步后仍为 `unknown`；从实际 checkpoint 恢复再推进 1000 步，累计 201000 步，复用 7531 次重复局面。尚未达到空盘必胜证书的验收条件。恢复点和运行结果保存在报告中的仓库相对路径下，属于本地运行产物。

后续的[成熟实现参考与实测](../../docs/m5-ai/rust-mature-report.json)记录了威胁搜索、对称证明复用和开局数据编译结果。双活三证书由 217 个节点减少为 3 个，仍覆盖全部 216 个合法防守，并通过 Rust / TypeScript 双向检查；空盘仍是 `unknown`。

[本轮优先级落地报告](../../docs/m5-ai/rust-priority-report.json)记录了 fucusy 提示导入、持久证明缓存、待算清单、依赖组合、安静准备手和实验性 DFPN。真实样本导入 676 条对称归一后的提示；首次搜索和引导续算后保存 14406 个已复验的局部策略，空盘仍为 `unknown`。缓存条数不是根局面证明进度。

## 构建与测试

在仓库根目录执行，需要 Rust/Cargo 和已有 pnpm 环境：

```sh
pnpm build
pnpm test
cargo clippy --locked --manifest-path crates/gomoku-solver/Cargo.toml --all-targets -- -D warnings
```

根目录 build 包含 release 构建，test 包含 Rust 单测和原有 Vitest 测试。测试覆盖四方向、长连、满盘无五、全盘候选、战术胜法、完整防守、非法证书、所有合法应手的策略执行、分片一致性、断点恢复、置换复用和与独立穷举 minimax 的小残局对照。另有 Rust 与 TypeScript 双向独立复验集成测试。

## 离线求解

所有命令均在仓库根目录执行，坐标从 0 到 14，输入为未结束的交替落子序列。输出路径必须尚不存在。

```sh
mkdir -p output/rust-solver
pnpm ai:rust:prove docs/m5-ai/examples/rust-double-three.input.json output/rust-solver/local.proof.json
pnpm ai:rust:verify output/rust-solver/local.proof.json
pnpm ai:rust:export output/rust-solver/local.proof.json output/rust-solver/local.tree.json
pnpm ai:verify output/rust-solver/local.tree.json
pnpm ai:rust:move output/rust-solver/local.proof.json docs/m5-ai/examples/rust-double-three.input.json
```

`solve` 成功输出扁平的 `gomoku-proof-dag-v1` 证书。`verify` 也可直接导入现有 `gomoku-proof-v1` 树证书；`export` 输出兼容 TypeScript 检查器的树格式，展开限制为 200000 节点。DAG 允许更大的共享策略；默认检查器最多访问 2000000 次，库可显式配置检查预算。检查预算耗尽不会被判为已证明。

输入只接受 `moves` 和可选的 `options`；选项为 `maxAttacks`（0–113）、`maxNodes`（非负整数）、`timeBudgetMs`（非负整数），以及可选的 `tactics: { maxAttacks, maxNodes, threes }`。未知字段、负数、小数预算和非法坐标均被拒绝。不接受 TypeScript 的 `mode`/`algorithm` 参数。`solve` 不配置 `tactics` 时保持原有完整候选搜索；配置后在攻击叶节点先尝试有限预算的战术证明，未找到证明时继续完整搜索。战术节点数另计在 `tacticalNodes` 中，战术预算按每次叶节点调用计算。

`maxNodes` 限制本次新增的边展开步数，每步至多新建一个节点；统计中的 `nodes` 是实际节点数，`expansions` 是累计展开步数。默认每次运行 100000 步、60000 毫秒，命令行 `--max-nodes N`、`--time-ms N` 可覆盖输入预算。时间在每次展开前检查，单次展开和最终复验可能使墙钟耗时略超预算。

退出码：0 表示证书已复验或找到策略内落点；2 表示 `unknown` 或局面不在策略内；1 表示输入、IO 或验证错误。`verify` 的 `guaranteedFirstPlayerWin` 只有在空盘执黑证书通过检查时才为 true。

## 空盘求解与恢复

```sh
pnpm ai:rust:prove docs/m5-ai/examples/rust-empty.input.json output/rust-solver/empty.result.json --checkpoint output/rust-solver/empty.checkpoint.json
pnpm ai:rust:resume output/rust-solver/empty.checkpoint.json output/rust-solver/empty.next.json --max-nodes 1000000 --time-ms 600000
```

首次运行不覆盖已有文件。恢复默认更新原 checkpoint，结果写入新的输出文件；每约 5 秒和正常退出前在同一目录写临时文件、同步并原子替换 checkpoint。强制结束时可恢复上次已完成的 checkpoint，最后数秒工作可能需要重做。

checkpoint 是 `gomoku-search-checkpoint-v1` 的确定性展开日志，**不是胜法证书**。恢复时从输入重新执行并校验每一步日志，不信任文件中自报的证明结果；可恢复的版本需要保持搜索排序和规则一致。恢复成本与已记录的展开量成正比，且不计入本次新增求解预算。当前日志不是直接内存快照，不提供跨算法版本的恢复保证。

`move` 验证证书后，按实际棋谱选择防守分支；对手忽略冲四或双胜点时直接成五。局面不符合证书起始棋谱或我方已经偏离策略时，返回空落点。要保持保证，调用方不得用启发式落点覆盖已验证策略。

## 参考开局数据编译策略

参考了 [rdragon/gomoku-ai 的威胁搜索](https://github.com/rdragon/gomoku-ai/blob/main/src/tss.c)、[连续冲四搜索](https://github.com/rdragon/gomoku-ai/blob/main/src/tss_fours.c)、[rv2 的公开策略数据结构](https://github.com/maximrud/rv2)，以及 [fucusy 的局面到落点数据与威胁依赖搜索](https://github.com/fucusy/gomoku-first-move-always-win)。实现为独立编写的 Rust，没有引入这些项目的源码或运行时依赖；外部开局数据不随仓库分发。[Rapfi](https://github.com/dhbloo/rapfi) 的评估和选择性搜索可用于棋力参考，其输出不作为本项目的证明依据。

`compile BOOK INPUT OUTPUT` 接受 rv2 风格的嵌套坐标对象（`a1`–`o15`），数值叶子的胜负、距离声明全部忽略。输入落子必须合法，支持八种棋盘旋转/反射映射；对称局面复用的证书会映射所有攻击点、防守点和子图，再按实际局面独立检查。

```sh
pnpm ai:rust:prove docs/m5-ai/examples/rust-tactics.input.json output/rust-solver/tactical.dag.json
pnpm ai:rust:compile "$GOMOKU_BOOK" docs/m5-ai/examples/rust-book-leaf.input.json output/rust-solver/book-leaf.dag.json
pnpm ai:rust:compile "$GOMOKU_BOOK" docs/m5-ai/examples/rust-guided-empty.input.json output/rust-solver/guided.result.json
```

`GOMOKU_BOOK` 由调用方指定为本地开局文件。rv2 的说明针对 standard 规则，本项目仍按 freestyle-15 检查每个实际应手，不能把其胜负声明直接迁移为保证。示例的 18 个攻击层是用于检查其 35 手声明的有限搜索范围，不代表已验证这个界。

`compile` 的 `maxNodes` 统计搜索入口、候选进攻、防守分支和预搜索工作，区别于 `solve` / `dfpn` 的边展开数。支持 `--max-nodes N`、`--time-ms N`、`--max-attacks N`；时间从开局数据与缓存导入后开始，单次规划、片段检查、最终复验和落盘可能超出时间预算。全防点预搜索只得到不可信计划，并用一小部分预算试探；它失败后继续普通战术搜索。

未得到证书时输出 `gomoku-guided-search-v1`、`unknown` 以及统计信息。预算耗尽时尽可能附带 `frontier`（合法、未终局、轮到原攻击方的 `Game`），可取其棋谱继续分析；它可能属于尚未确认正确的进攻分支，不是对手必然可达的反例。`exhausted` 只表示候选战术和开局提示在给定深度内用尽，不能据此宣布必败或否定外部项目。

## fucusy 数据导入

```sh
pnpm ai:rust:import "$GOMOKU_RECORDS" output/rust-solver/hints.json
```

`GOMOKU_RECORDS` 是调用方提供的文件或目录。导入器支持 `h8_a1:i9` 棋谱记录，以及 15 个逗号分隔的十进制 30 位行值加 `:坐标` 的棋盘记录。每格两位，低位对应左端：`01` 黑、`10` 白、`11` 空；拒绝 `00`、非法棋数、终局、非黑方轮次和占用落点。可显式用 `:h8` 提供空盘天元提示；导入器不自行补入初始落点。

目录递归选择 `*.board2action.txt`、`board2action_from_dir.txt`、`manually_added_step_str2move.txt`，不跟随目录中的符号链接。单次输入最多 128 MiB、200000 条记录；较大目录需分批处理。导入结果为严格校验的 `gomoku-opening-hints-v1`，以完整双颜色棋盘做八对称归一与去重，仍仅表示落点提示，不接收“已经验证”的外部声明。直接 `compile` 也接受这个格式。

## 持久证明缓存和条件待算清单

```sh
pnpm ai:rust:compile output/rust-solver/hints.json docs/m5-ai/examples/rust-guided-empty.input.json output/rust-solver/first.result.json --cache output/rust-solver/proofs.cache.json --worklist output/rust-solver/first.worklist.json --quiet-moves 4 --max-nodes 200000
pnpm ai:rust:work output/rust-solver/hints.json output/rust-solver/first.worklist.json output/rust-solver/next.worklist.json --cache output/rust-solver/proofs.cache.json --max-nodes 100000 --max-jobs 8 --max-attacks 24
```

缓存 `gomoku-proof-cache-v1` 在新增和重新加载时逐条独立验证证书。键包含双方全部棋子与轮次，旋转/反射复用时同时映射攻击点、防守点和子图；仅有文件或键命中不能把未知局面标成胜。最多保存 20000 条、1000000 个证书节点，满后拒绝新增，不影响本次根证书输出。缓存没有淘汰、分片或多写者合并机制。

`compile` 结束时、`work` 每完成一个任务及退出前，原子更新同一缓存文件。`compile` 不保存递归栈；强制中止会丢失本次尚未写出的证明。待算清单为 `gomoku-worklist-v1`，保存原始根棋谱、搜索深度、安静手策略、引擎和轮转游标。继续时重新搜索未完成任务，复用已经验证的子证明，不是恢复逐节点执行现场。需要完整 PNS 展开日志的场景继续使用 `solve` / `resume`。

清单中的任务来自候选黑方进攻，是**条件子局面**；最多导出 1001 个含根任务的去重局面，`truncated: true` 表示尚有任务未导出。即使清单中所有局部任务都解出，也需重新组合并独立验证根策略。每轮保留根任务以便组装，轮转游标让未解任务轮流获得预算；深度耗尽任务不占 `max-jobs`，可用 `--max-attacks` 提高相对原始根的总攻击深度。未知任务清单不能视为必达反例集或空盘覆盖证明。

`work` 的节点、时间和任务数预算是本轮总额。找到完整根证明时输出文件是胜法证书；否则输出下一轮待算清单。缓存与输出文件需使用不同路径，输出必须尚不存在；缓存可在后续轮次更新。

`--quiet-moves N`（0–225，默认 0）每条搜索路径至多增加一个安静准备手，按排序选择前 N 个尚未列入威胁或开局提示的空点。白方防守仍逐点覆盖。N=225 覆盖这一步的全盘准备候选，但不会使后续选择性战术搜索变成完整求解；开局提示与强制堵四不消耗这个准备手额度。

## 实验性 DFPN

```sh
pnpm ai:rust:dfpn docs/m5-ai/examples/rust-double-three.input.json output/rust-solver/dfpn.proof.json --max-attacks 3 --max-nodes 4000
pnpm ai:rust:work output/rust-solver/hints.json output/rust-solver/next.worklist.json output/rust-solver/dfpn.worklist.json --cache output/rust-solver/proofs.cache.json --engine dfpn --max-nodes 10000 --max-jobs 4
```

DFPN 按证明数/反证数阈值深搜，复用完整 PNS 的全盘候选、规则压缩、置换图和独立证书链路。支持同一持久证明缓存，已证明子图可供后续引导搜索使用；清单保存引擎选择，后续可用 `--engine guided` 切回。DFPN 的预算单位为新增边展开，不能与引导搜索的工作量直接比较。

独立 `dfpn INPUT OUTPUT` 支持 `--cache`、`--max-attacks`、`--max-nodes`、`--time-ms`，未找到证明输出 `gomoku-dfpn-search-v1`。当前原型保留完整 arena，并未实现 DFPN 的内存回收或执行现场 checkpoint；通过小残局独立穷举对照和全防守证书检查，不代表已经测得速度或内存优势。`work --engine dfpn` 每轮重建未完成任务的搜索图，只保留可复验的胜法子图。
