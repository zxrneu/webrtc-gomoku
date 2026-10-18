# 人机对战 · 任务分解（M5 · AI Opponent）

> 配套设计：`docs/m5-ai/architecture.md`（API 签名 / 评分表 / 参数表以其为准，接口不得漂移）。
> **TDD 强制**：每个任务的第一步是把该任务的测试写成「红」，再写实现转「绿」，最后重构。
> 每个任务收尾必须 `pnpm build && pnpm test` 全绿才可提交（AGENTS §1 铁律 2/3）。

## 1. 任务表

| 编号 | 标题 | 涉及文件 | 依赖 | 验收标准 |
|---|---|---|---|---|
| **T01** | core AI 基础层：类型 / 参数表 / Zobrist / 棋型识别 | 【新】`packages/core/src/ai/types.ts`、`config.ts`、`zobrist.ts`、`pattern.ts`<br>【新】`packages/core/test/ai/{pattern,config}.test.ts` | — | ① 先写 `pattern.test.ts` 表驱动用例 ≥24 条，覆盖 architecture §1.2 表中**每一行**棋型 + 优先级（`11111` 判 FIVE 而非 OPEN_FOUR）② `zobrist` 同种子两次生成完全相同，两次 `createSearchSession` 前的表 diff 为空 ③ `DIFFICULTY_PRESETS` 三档数值 = 200/2 / 500/4 / 1000/12，`Object.isFrozen` 为 true ④ `grep -r "Math.random\|Date\.\|performance\." packages/core/src/ai` 无输出 ⑤ `pnpm --filter @webrtc-gomoku/core build` 通过 |
| **T02** | core 评估与走法生成 | 【新】`packages/core/src/ai/evaluate.ts`、`movegen.ts`<br>【新】`packages/core/test/ai/{evaluate,movegen}.test.ts` | T01 | ① 红测先行：`evaluate` 用例含「我方活四 > 对方活三」「双活三 > 单冲四」两组单调性断言 ② `movegen` 用例：空盘返回 `[(7,7)]`；邻域半径 >2 的点不在候选；`attack(me)` 得分降序且 tie-break 按 `idx` 升序（连跑 3 次同序）③ **强制短路**：己方有成五点 → 候选长度 = 1 且为该点；对方有成五点 → 候选全为堵点 ④ 分支上限 root ≤14 / depth≤3 ≤10 / 更深 ≤6 ⑤ 单测总耗时 < 200ms |
| **T03** | core 搜索、置换表、算杀与对外门面 | 【新】`packages/core/src/ai/{tt,search,opening,index}.ts`<br>【改】`packages/core/src/index.ts`（追加 `export * from './ai'`）<br>【新】`packages/core/test/ai/{tt,search,session,opening,api,bench-tactics}.test.ts` | T02 | ① **`bench-tactics.test.ts` 先写**：PRD S1 的 20 题（一步成五×4 / 堵成五×4 / 活三防守×4 / 双三双四×4 / 三步 VCF×4），`hard` 档断言 **20/20**，`easy` 档 ≥10/20 ② `session.test.ts`：注入假 `now`（每次 `+8ms`）断言 `step()` 在预算内返回 false 且 `stats().cutoff==='time'`；同局面连跑 5 次 `result()` 完全相同；`abort()` 后仍返回已完成层解 ③ 无 `now` 时按 `maxNodes` 收敛，`pnpm test` 新增用例总耗时 < 1s ④ `opening.test.ts`：空盘执黑必 `(7,7)`；玩家首手 `(7,7)` 后 AI 白子落在中心 3×3 ⑤ `api.test.ts`：`findBestMove` 对 `over=true` / 已占点 / `size!==15` 均返回 `null` 且不抛 ⑥ `tt.test.ts`：碰撞后 bestMove 复核为空点才可用 |
| **T04** | web 纯逻辑层：棋局操作 / 分片调度 / 持久化 | 【新】`packages/web/src/ai/aiGame.ts`、`searchDriver.ts`、`aiStorage.ts`<br>【新】`packages/web/test/{ai-game,ai-driver,ai-storage}.test.ts` | T03 | ① `ai-game.test.ts`：玩家落子后 `moves` +1；`undoPair` 退 2 步且 `currentColor===playerColor`；`moves<2` 或我方棋数为 0 时 `canUndo===false`；AI 执黑开局自动落 `(7,7)` ② `ai-driver.test.ts`：注入假 `schedule`（同步收集回调）+ 假 `now`，断言 `step` 被调用 ≥2 次（即**真的分片**）、`onDone` 只触发 1 次、取消函数调用后不再触发 ③ `ai-storage.test.ts`：无 localStorage / 抛异常时降级为 `hard`+`BLACK` 且不抛 ④ 全部用例不启动浏览器、不依赖 `@testing-library` |
| **T05** | UI 集成：双棋局共存 / 人机面板 / 模式切换 / 回归 | 【新】`packages/web/src/ai/useAiGame.ts`、`components/AiPanel/AiPanel.tsx(+.module.css)`、`components/ModeSwitch/ModeSwitch.tsx(+.module.css)`<br>【改】`components/Board/Board.tsx`、`App.tsx`、`App.module.css`、`types.ts`<br>【新】`packages/web/test/ai-wiring.test.ts` | T04 | ① `ai-wiring.test.ts`（源码结构断言，沿用 `app-wiring.test.ts` 风格）：`useConnection({...})` 参数块内不出现 `ai`；`onMovesReplaced` 内只 `setGame`；`App.tsx` 无 `new WebSocket`/`new RTCPeerConnection` ② `Board` 新增 props 全部可选 ⇒ 联机路径零改动（既有 `app-wiring.test.ts` 全绿）③ thinking 期连点 10 次 `moves.length` 不变（`ai-game.test.ts` 用守卫断言）④ `pnpm build` 通过，`dist` 单文件体积增量 ≤30KB min / ≤10KB gzip（build 前后 `ls -l` 对比并记录在 PR 描述）⑤ `pnpm test:e2e` 全绿不回归 ⑥ `window.__gomoku.ai` 暴露 `{ mode, thinking, moves, difficulty }` 供 e2e 断言 |

## 2. 串行约束（防接口漂移）

- **T01 → T02 → T03 必须由同一人连续完成**：`AiBoard`/`cellAt`/`PATTERNS`/`DIFFICULTY_PRESETS` 的签名在三个任务间高频复用，换手必漂移。中途交接必须附带已冻结的 `types.ts` 全文。
- **T04 → T05 必须由同一人连续完成**：`useAiGame` 返回对象是 UI 的唯一契约。
- T03 与 T04 之间**只通过 `packages/core/src/ai/index.ts` 的导出**耦合，禁止 web 深引 `core/src/ai/search.ts`。
- 允许并行的只有 T05 的 `ModeSwitch` / `AiPanel` 纯样式部分（不涉及接口）。

## 3. DoD 清单（全部打勾才算交付）

```
[ ] pnpm build            全绿（core → shared → web → server）
[ ] pnpm test             全绿，且「新增用例」耗时 < 1s
[ ] pnpm test:e2e         全绿，联机全流程零回归
[ ] 基准集 hard 20/20、easy ≥10/20（bench-tactics.test.ts）
[ ] 单步耗时 P95 ≤ 1000ms、最坏 ≤ 1500ms（session.test.ts + 浏览器实测记录）
[ ] 一局中 longtask(>50ms) = 0（PerformanceObserver 手工采样 1 局，截图存档）
[ ] 打包体积增量 ≤ 30KB min / ≤ 10KB gzip（build 前后对比）
[ ] core 零新增依赖（package.json diff 为空）、无 Date/performance/window/Math.random 直读
[ ] 每个新增导出函数有对应用例（AGENTS §1 铁律 5）
[ ] 联机态切人机再切回：moves 逐手一致、无 socket 重连（DevTools Network 截图）
[ ] 代码审查项：无 any、无 console.log、无死代码、中文注释、UI 无棋力魔数
```
