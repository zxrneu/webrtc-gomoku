# AGENTS.md — AI 编码代理协作规范

> webrtc-gomoku 仓库所有 AI 编码代理的强制协作指南。目标：**高内聚、低耦合、完整测试覆盖**。

## 1. 目标与铁律

**代码标准**：模块职责一句话说得清；依赖单向显式；核心逻辑可毫秒级无网单测；新需求靠「新增」而非「改旧」落地；外部输入必须校验转义。

**铁律**：
1. 先测试后实现（§3 TDD），禁止先实现后补测试
2. 小步提交，每步 `pnpm build && pnpm test` 通过
3. 构建/测试失败必须修复或如实上报，不带着错误往下写
4. 只做被要求的变更，不擅自扩大范围
5. `core`/`shared` 每个导出函数必须有对应用例

**项目速览**：pnpm monorepo｜TS strict（含 `noUncheckedIndexedAccess`）｜Vitest｜React + CSS Modules｜ws 服务器

```
web ──► shared ──► core      # 依赖只允许单向；core 零 IO/DOM 依赖
server ──► shared ──► core
```

常用命令：`pnpm test`（单测必跑）· `pnpm build`（必跑）· `pnpm dev` · `pnpm dev:server` · `pnpm test:e2e`（改 web/server 后跑）

## 2. SOLID 落地实践

> 每原则附检查项，全部通过才允许提交。

### S — 单一职责
一个模块只有一个引起变化的原因。按变化轴拆文件：规则（core）/ 协议（shared/codec）/ 渲染（web/components）/ 连接（webrtc.ts、server）。
- [ ] 职责能否一句话说清？函数 ≤50 行、嵌套 ≤2 层、参数 ≤3？
- [ ] `core`/`shared` 无 IO/DOM/全局副作用导入？
- [ ] 一个需求变更是否只动一个模块？

### O — 开闭原则
对扩展开放，对修改关闭。用判别联合表达可扩展结果集（如 `MoveResult`），switch 必须有穷尽性兜底；新规则变体用新函数 + 组合，不改 `applyMove` 主流程。
- [ ] 新需求通过「新增联合成员/新函数/新文件」完成？
- [ ] 是否在既有函数里堆 `if (rules === ...)` 分支？（应抽策略）
- [ ] 改既有导出签名时，所有调用点与测试已同步？

### L — 里氏替换
子类型可无缝替换父类型。先定契约（前置/后置条件）再实现，用契约测试守住；优先组合而非继承；失败用明确返回值（`{ ok: false, reason }`），不用异常风暴。
- [ ] 每个实现满足同一份契约测试？
- [ ] 有无「为复用硬造继承」？
- [ ] 子类是否加强前置条件/削弱后置条件/抛未声明异常？

### I — 接口隔离
客户端不依赖不需要的方法。按角色拆细粒度类型：渲染只要 `{board, winLine, over}`，信令只要 `{moves}`。
- [ ] 接口每个成员都有真实调用方？单个 interface ≤10 成员？
- [ ] 有无空实现/`not implemented` 占位（= 接口过胖）？
- [ ] 消费方 import 精确到所需字段？

### D — 依赖反转
高层不依赖低层，二者依赖抽象。IO 能力（ws/Date/random）通过参数注入而非内部 `new`，保证可注入假实现。
- [ ] import 方向符合 §1 分层图？无循环依赖？
- [ ] IO 入口可注入或被测试替身替换？
- [ ] 单测不启动真实网络/浏览器（`pnpm test` 毫秒级）？

## 3. TDD 工作流（Red-Green-Refactor）

**RED**：先写失败测试。行为命名（`it('越界落子被拒绝')`），一个 it 一个行为，Arrange-Act-Assert；确认因「缺功能」失败而非语法错误；之后不许改测试迁就实现。
**GREEN**：写能通过的最简实现，允许硬编码/特例；禁止顺手多写没被测试要求的功能。
**REFACTOR**：测试全绿保护下消除重复、拆长函数、应用 SOLID；每步重跑 `pnpm test`，变红即回退。

| 项 | 规范 |
| --- | --- |
| 位置 | `src/<module>.ts` ↔ `test/<module>.test.ts` 对称（如 `core.test.ts`） |
| 覆盖 | core 每个导出函数 ≥1 用例；每个失败分支（game-over/occupied/out-of-board/not-your-turn）≥1；胜负四方向 + 长连 + 平局 + 悔棋全覆盖 |
| 断言 | 断言行为与状态，不断言私有实现；`toBe(BLACK)` 优于 `toBeTruthy()` |
| 可复现 | 显式数据序列，禁随机；时间/随机数用参数注入 |
| 豁免 | 纯 CSS、e2e 脚本可不写单测，但必须跑 build（+e2e）验证 |

## 4. 代码审查标准

提交前自审 + 审查人复核，逐项过：

- **正确性** — build/test 通过；新功能有先失败后通过的测试；边界（空值/越界/异常消息）已处理；对端消息先过 codec 校验、用户输入渲染前转义（防 XSS）
- **设计** — §2 检查项全过；命名规范（布尔 `isX/hasX`，函数动词）；无循环/反向依赖
- **测试** — Red-Green-Refactor 顺序；一个 it 一个行为；重构后仍全绿
- **安全** — 无硬编码密钥；无裸 `any`（用 `unknown` + 收窄）；无 `console.log`/死代码

**BLOCK（拒绝提交）**：测试未先行 · build/test 失败 · 依赖倒挂 · any 逃逸 · 硬编码密钥

## 5. 典型场景

- **① 新增禁手规则（OCP+TDD）**：先写失败测试 `create({ rules: 'forbidden' })` → 扩展联合类型 + 新策略函数 `detectForbidden()` → `applyMove` 只加策略注入点，`free` 路径零改动，旧测试全绿即证明。
- **② 新增表情消息（TDD+联合类型）**：codec 测试先行（往返一致）→ `types.ts` 扩判别联合 → codec 加分支；未知 `t` 返回明确错误而非崩溃。
- **③ Board.tsx 减重（SRP）**：胜负判定移回 core（已有测试护航）→ 音效抽 hook → 落子改 props 派发，组件不再 import webrtc.ts。每步小重构，每步验证。
- **④ 信令模块单测（DIP）**：`createRoom(channel: SignalChannel, now = Date.now)` 注入接缝，假 channel + 固定时间即可无网测试。

## 6. 一页速查

```
写代码前 5 问：先写测试了吗？职责说得清吗？是新增还是改旧？import 方向对吗？能脱离网络测试吗？
提交前：pnpm build && pnpm test 全绿；改 web/server 追加 pnpm test:e2e
红线：测试未先行 / 构建失败 / 依赖倒挂 / any 逃逸 / 硬编码密钥 → 拒绝提交
```
