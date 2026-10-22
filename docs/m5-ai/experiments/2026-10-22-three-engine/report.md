# TS、Rust/WASM 与原生 Rust 三方对弈

日期：2026-10-22。引擎代码基线：7e6a359；比赛适配器、赛程脚本和测试见提交 8c0d508。环境：v26.3.0 darwin/arm64。

共 24 局正式对局：18 局 500ms/手、6 局 3000ms/手；每对交手 8 局，每个引擎各 16 局、执黑执白各 8 局。6 局强制成五的链路校验和此前的 4 局对战均未计入。

## 两两成绩

数字均为左侧引擎的胜 / 负 / 和。

| 对阵 | 500ms（各 6 局） | 3000ms（各 2 局） | 总计（各 8 局） |
| --- | --- | --- | --- |
| TS 对 Rust/WASM | 2 / 4 / 0 | 1 / 1 / 0 | 3 / 5 / 0 |
| TS 对 原生 Rust* | 3 / 3 / 0 | 1 / 1 / 0 | 4 / 4 / 0 |
| Rust/WASM 对 原生 Rust* | 2 / 3 / 1 | 1 / 1 / 0 | 3 / 4 / 1 |

| 引擎 | 胜 | 负 | 和 | 黑棋胜 | 白棋胜 |
| --- | ---: | ---: | ---: | ---: | ---: |
| TS | 7 | 9 | 0 | 5 | 2 |
| Rust/WASM | 8 | 7 | 1 | 5 | 3 |
| 原生 Rust* | 8 | 7 | 1 | 5 | 3 |

* 原生 Rust 本来是证明求解器，unknown 时没有通用对弈选点。本次新增的比赛专用适配器先执行已验证策略，再求证，最后按立即成五、堵对手立即成五、既有原生五格窗口排序兜底；全部选点在原生 Rust 中完成。437 次实际落子中，58 次执行已验证证明，379 次兜底（86.7%）。兜底次数包括堵四和直接成五，保持 unknown，不冒充证明。

## 如何解读

3000ms 下 TS 与 Rust/WASM 的两局均为黑棋第 69 手获胜，全部落点完全相同。两者共用生产 TS 搜索、算杀和证明校验，Rust/WASM 替换评分；不能把它们视为两个独立搜索算法。500ms 的限时分歧可以来自预算耗尽时完成的搜索工作不同。

原生适配器在本批对局中可以与网页引擎互有胜负。它的证明搜索与未知局面选点策略、预算分配均与网页不同；本实验比较现有组合的实战表现，不能据此断言 Rust 语言更强、纯证明算法更强，或获得稳定 Elo 排名。多数落子仍需兜底，也没有空盘必胜证书；对有限对手的胜率不能替代覆盖任意合法后手应对的策略证明。

## 比赛条件

- 15×15 freestyle，无禁手，五连及长连获胜。500ms 组使用三个显式开局：空盘、6 手聚集局面、12 手分散局面；3000ms 组仅用空盘。预设开局的全部坐标保存在 JSON 的 plan 和各局 opening 字段中。
- 顺序运行并互换执色，计时期间不并行编译或跑测试。双方时间预算相同，搜索算法及节点定义不同；节点数不能直接比较。固定开局可能偏向某一方，不能当作均匀随机样本。
- 网页引擎调用真实 createSearchWorkerHandler，各有独立的该局策略缓存；Node 中预热两条评分路径，注入真实墙钟，保留生产分片搜索和缓存策略执行。没有浏览器渲染、Worker 传输和定时器等待开销。
- TS / Rust-WASM 均使用 hard 预设，只覆盖该组 timeBudgetMs。原生适配器使用空提示库，无跨局证明缓存；战术求证最多用 75% 时间，其余给 DFPN，两阶段各限 100000 个各自定义的节点单位，攻击深度上限 113。未知不计为认输。
- 时间是搜索的软预算；构造会话、证书校验、原生进程通信和策略序列化可能产生额外耗时。每手 wallMs 已记录。所有对局均下到合法终局，未提前按分数、步数或 unknown 判胜负。

## 逐局结果

| 预算 ms | 开局 | 黑 | 白 | 胜者 | 总手数 | 用时 s |
| ---: | --- | --- | --- | --- | ---: | ---: |
| 500 | empty | TS | Rust/WASM | TS（黑） | 71 | 30.39 |
| 500 | empty | Rust/WASM | TS | Rust/WASM（黑） | 31 | 11.03 |
| 500 | empty | TS | 原生 Rust* | TS（黑） | 23 | 9.19 |
| 500 | empty | 原生 Rust* | TS | 原生 Rust*（黑） | 131 | 55.51 |
| 500 | empty | Rust/WASM | 原生 Rust* | Rust/WASM（黑） | 23 | 9.14 |
| 500 | empty | 原生 Rust* | Rust/WASM | 和棋 | 225 | 97.66 |
| 500 | cluster-6 | TS | Rust/WASM | Rust/WASM（白） | 46 | 11.88 |
| 500 | cluster-6 | Rust/WASM | TS | TS（白） | 46 | 11.92 |
| 500 | cluster-6 | TS | 原生 Rust* | TS（黑） | 29 | 9.15 |
| 500 | cluster-6 | 原生 Rust* | TS | TS（白） | 40 | 14.20 |
| 500 | cluster-6 | Rust/WASM | 原生 Rust* | 原生 Rust*（白） | 124 | 52.00 |
| 500 | cluster-6 | 原生 Rust* | Rust/WASM | Rust/WASM（白） | 26 | 7.90 |
| 500 | scattered-12 | TS | Rust/WASM | Rust/WASM（白） | 52 | 15.92 |
| 500 | scattered-12 | Rust/WASM | TS | Rust/WASM（黑） | 103 | 38.52 |
| 500 | scattered-12 | TS | 原生 Rust* | 原生 Rust*（白） | 48 | 14.67 |
| 500 | scattered-12 | 原生 Rust* | TS | 原生 Rust*（黑） | 25 | 3.31 |
| 500 | scattered-12 | Rust/WASM | 原生 Rust* | 原生 Rust*（白） | 48 | 14.62 |
| 500 | scattered-12 | 原生 Rust* | Rust/WASM | 原生 Rust*（黑） | 23 | 3.23 |
| 3000 | empty | TS | Rust/WASM | TS（黑） | 69 | 132.68 |
| 3000 | empty | Rust/WASM | TS | Rust/WASM（黑） | 69 | 133.77 |
| 3000 | empty | TS | 原生 Rust* | TS（黑） | 29 | 49.21 |
| 3000 | empty | 原生 Rust* | TS | 原生 Rust*（黑） | 61 | 135.12 |
| 3000 | empty | Rust/WASM | 原生 Rust* | Rust/WASM（黑） | 29 | 49.20 |
| 3000 | empty | 原生 Rust* | Rust/WASM | 原生 Rust*（黑） | 61 | 135.36 |

## 校验和复现

全部 1432 手（含预设开局）重放至合法终局，并独立按四方向计数核对胜负。154 次证明落子所引用的 108 份唯一证书全部通过 TS 与原生 Rust 两个检查器；不存在声明已证明必胜后却输棋或和棋的情况。评分路径检查未发现意外 WASM 回退。

新增功能经过先失败后通过的测试；pnpm build、91 项 Rust 测试、90 个测试文件中的 1323 项 JS/TS 测试和 Rust 全目标严格 Clippy 通过。首次全量运行中既有 Docker 构建用例超过 5 秒，单独复核用时 633ms，随后全量重跑通过。

从仓库根目录：

```sh
pnpm build:core
cargo build --locked --release --manifest-path crates/gomoku-solver/Cargo.toml --example match-player
node --import tsx scripts/ai-three-engine-match.mjs --output=output/ai-three-engine-new-run
```

输出目录已存在时使用 --resume 跳过已完成局，未完成局从头重赛；或选择新目录。--smoke 只跑六局强制成五的链路检查。

[完整原始数据与棋谱](matches.json) · [独立审计](audit.json)。history 包含预设开局的全部 x/y 坐标；moves 仅记录引擎实际决策的手，附耗时、来源和证明哈希，对应 proofs/<hash>.json。坐标均从 0 开始。
