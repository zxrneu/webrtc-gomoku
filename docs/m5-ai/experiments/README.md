# AI 对弈实验归档

| 实验 | 对局数 | 保存内容 |
| --- | ---: | --- |
| [TS / Rust-WASM / 原生 Rust 三方赛](2026-10-22-three-engine/report.md) | 24 | 棋谱、逐手统计、108 份证明证书、双检查器复验结果 |
| [TS / Rust-WASM 互换执色对照](2026-10-22-wasm-ts/report.md) | 4 | 3000ms 限时对局与固定节点对照的棋谱、逐手统计；当时复验的证书未另存 |

归档保留实测时的版本、平台、预算、日期和结果。三方赛的原生 Rust 使用求证优先、原生排序兜底的比赛适配器；对局胜率不代表空盘先手必胜证明，也不能归因于实现语言。

复现实验使用[三方赛脚本](../../../scripts/ai-three-engine-match.mjs)和[原生比赛适配器](../../../crates/gomoku-solver/examples/match-player.rs)，命令见各报告与[求解器说明](../../../crates/gomoku-solver/README.md#三方对弈实验)。新实验输出到 `output/` 的新目录，保留本目录内的历史结果。

三方赛 `matches.json` 的 `history` 包含预设开局和全部实际落子；`moves` 仅记录引擎实际决策的手。每手的 `proofSha256` 对应同目录 `proofs/<hash>.json`，可独立交给检查器：

```sh
pnpm ai:rust:verify "docs/m5-ai/experiments/2026-10-22-three-engine/proofs/<hash>.json"
```
