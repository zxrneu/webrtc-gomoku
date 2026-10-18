# AI 引擎升级与能力边界

## 浏览器计算

人机模式通过 `aiSearch.ts → workerClient.ts → search.worker.ts` 启动并复用一个 Web Worker。搜索和策略复验在 Worker 中执行；React、棋盘绘制和交互留在主线程。请求 ID 隔离不同棋局，切模式、重开和取消后不会接收旧结果。

Worker 以 Blob 内联到构建产物，HTTP 页面和直接打开的 `dist/gomoku-standalone.html` 都可离线下棋。Worker 不可用、初始化失败或消息异常时，自动使用可取消的主线程分片搜索。

一个 Worker 使用一个计算线程，主要改善交互响应；当前没有实现多核搜索池，也没有把 JavaScript 换成 WASM。分片通过生成器保留递归栈与棋盘，暂停后继续同一个候选，不再因分片跳过未完成的候选。连续冲四搜索也遵守时间分片；总预算不足一层时返回合法兜底手，完成深度保持为 0。

## 求胜与证明

普通搜索使用迭代加深、Alpha-Beta、置换表和候选裁剪。高估分、开局策略和有限深度都不能证明必胜。`AiSearchStats.proofStatus` 只有两种状态：

- `win`：`winningProof` 已通过独立规则检查器，可以覆盖当前局面所有合法防守应手。
- `unknown`：没有完整证明；不等于必败或和棋。

困难档在连续冲四之外，增加包含活三的有限预算 AND/OR 搜索。攻击方找到一条胜路即可；防守方必须覆盖全部空点，不能只验证邻近候选。证书支持直接成五、两个立即成五点、强制堵四链、完整防守分支。检查器不依赖棋型估分，按 15×15、交替落子、无禁手、五连或长连获胜的规则复验，也拒绝非法棋谱、缺失分支和循环证书。

Worker 保存当前已验证策略，后续回合沿对应应手分支落子；导入策略和导出 JSON 的入口是 `loadWinningStrategy()` 与 `WinningStrategy.toJSON()`。不在证书覆盖范围内时恢复普通搜索。

最强档在己方求胜未成功后，增加根候选的对手连续冲四复查。每个候选最多搜索 6 次对手进攻、256 个节点，找到反杀证书后再交给独立规则检查器验证；通过验证才排除该候选。已排除的候选不会因普通搜索预算不足而重新成为兜底手。所有根候选均被反杀时保留正常搜索，仍返回合法落子。简单、普通档保持原有流程。

反杀复查仍受总时间和根候选上限（14 手）限制。没有发现对手连杀的候选只代表“尚未被这次搜索证伪”，不代表安全或必胜，也不会把 `proofStatus` 改为 `win`。固定棋谱回归见 `packages/core/test/ai/defense.test.ts`，覆盖低节点预算、零层主搜索、旋转、分片和全部候选会输的情况。

**当前没有空盘黑棋的完整胜法证书，所以不能保证黑棋从开局对任意白棋每局必赢。** 已实现的是局面求胜、完整应手验证、证书存取和执行。空盘保证仍需要计算或引入一份覆盖全部白棋应手、可被本项目检查器复验的完整策略。增加深度或节点上限本身不构成保证。

## 离线求解与复验

输入按黑白交替给出坐标，范围为 0–14。`maxAttacks` 计攻击方落子的次数，`maxNodes` 限制搜索节点。时间源由 CLI 注入，core 没有 IO 或全局时钟。

```sh
pnpm ai:prove docs/m5-ai/examples/double-three.input.json /tmp/double-three.proof.json
pnpm ai:verify /tmp/double-three.proof.json
```

输出文件必须尚不存在。成功时写入 `gomoku-proof-v1` 证书，退出码为 0；预算不足或未找到证明时写入 `gomoku-search-v1`，退出码为 2；非法输入或复验失败时退出码为 1。示例双活三用 217 个搜索节点得到证明，覆盖 216 个防守应手；对应证书也保存在本目录 `examples/double-three.proof.json`。

搜索模式：`fours` 只找连续冲四，`threats` 包含活三，`complete` 枚举全部攻击点。三种模式都完整验证防守。`complete` 仍受深度、时间、节点预算限制，不代表已经解出空盘。

## 验证记录

- 分片与不分片落点一致，连续冲四可暂停、恢复、取消，极小分片仍能推进。
- 四方向、长连、双活三全应手证明、对手反杀、证书篡改、非法棋谱、预算耗尽均有单测。
- 浏览器验证 Worker 复用、取消、重开、HTTP 离线、`file://` 离线及无 Worker 回退；原有双人联机端到端回归通过。
- `pnpm build`、632 项单测、全部联机及 AI 端到端测试通过；core 严格类型检查通过。其中新增 9 项最强档反杀防守回归，先确认 6 项行为断言失败，再实现并全部通过。
- 本机 Chrome 多次实测 Worker 模式下主线程定时器最大间隔 13–17ms，未观测到超过 100ms 的主线程任务；这是测试场景记录，不是所有设备的性能保证。

运行：`pnpm build && pnpm test`，浏览器回归：先 `pnpm start`，再 `pnpm test:e2e`。浏览器测试支持 Playwright Chromium 或系统 Chrome。

额外运行 `pnpm exec tsc -p packages/web/tsconfig.json --noEmit` 仍有 4 处既有错误：`Connection/ConnectionPanel.tsx:94` 的 `isHost` 未使用，`connection/logger.ts:138` 的穷尽性收窄失败，`connection/wsTransport.ts:193` 的消息断言不兼容，以及 `types.ts:1` 的 `Color` 未使用。本次 AI 新模块没有类型错误；这些既有问题未扩大范围修改。现有 Web 构建脚本使用 Vite，不包含这项独立类型检查。
