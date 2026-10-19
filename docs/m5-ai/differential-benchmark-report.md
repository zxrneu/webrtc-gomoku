# TS / Rust-WASM 差分与性能实测

- 时间：2026-10-19T04:06:00.902Z
- 环境：v26.3.0 darwin/arm64
- 本次验证：**PASS**；搜索差分失败 0/40

## 验证结果

| 项目 | 实际样本数 | 差异/错误数 | 状态 |
|---|---:|---:|---|
| 棋型真值表 | 19683 | 0 | PASS |
| 全盘点分（空盘与合法中局，黑白双方） | 4950 | 0 | PASS |
| 独立战术断言（可防冲四、唯一堵点、双成五） | 6 | 0 | PASS |
| 生产 TS 合法落子 | 10 | 0 | PASS |

## 固定深度原型：TS 与独立 Rust 搜索

两端使用相同候选排序、深度、分支数和节点预算。Rust 端独立执行递归、强制防守和叶点评估。
以下 NPS 仅用于同策略原型比较，不能解释为生产最强档的加速比。

| 局面 | 深度 | TS/Rust 节点 | TS NPS | Rust NPS | 落点/分数/节点一致 |
|---|---:|---:|---:|---:|---|
| position-1/color-1 | 2 | 40/40 | 10356 | 20953 | PASS |
| position-1/color-1 | 4 | 180/180 | 13925 | 23206 | PASS |
| position-1/color-2 | 2 | 31/31 | 17476 | 25767 | PASS |
| position-1/color-2 | 4 | 150/150 | 17472 | 22978 | PASS |
| position-2/color-1 | 2 | 21/21 | 17465 | 23596 | PASS |
| position-2/color-1 | 4 | 207/207 | 17656 | 25466 | PASS |
| position-2/color-2 | 2 | 24/24 | 16962 | 24816 | PASS |
| position-2/color-2 | 4 | 121/121 | 19317 | 24065 | PASS |
| position-3/color-1 | 2 | 27/27 | 22070 | 23900 | PASS |
| position-3/color-1 | 4 | 344/344 | 22803 | 24772 | PASS |
| position-3/color-2 | 2 | 19/19 | 20469 | 21983 | PASS |
| position-3/color-2 | 4 | 206/206 | 21741 | 23401 | PASS |
| position-4/color-1 | 2 | 31/31 | 23259 | 24812 | PASS |
| position-4/color-1 | 4 | 183/183 | 22569 | 24397 | PASS |
| position-4/color-2 | 2 | 19/19 | 20286 | 22034 | PASS |
| position-4/color-2 | 4 | 100/100 | 21109 | 21741 | PASS |
| position-5/color-1 | 2 | 34/34 | 23699 | 25191 | PASS |
| position-5/color-1 | 4 | 329/329 | 22119 | 23376 | PASS |
| position-5/color-2 | 2 | 28/28 | 21908 | 23904 | PASS |
| position-5/color-2 | 4 | 156/156 | 22002 | 23617 | PASS |
| position-6/color-1 | 2 | 12/12 | 20644 | 20923 | PASS |
| position-6/color-1 | 4 | 70/70 | 21548 | 22223 | PASS |
| position-6/color-2 | 2 | 20/20 | 21340 | 22116 | PASS |
| position-6/color-2 | 4 | 131/131 | 22877 | 24243 | PASS |
| position-7/color-1 | 2 | 14/14 | 19863 | 20616 | PASS |
| position-7/color-1 | 4 | 206/206 | 23541 | 24945 | PASS |
| position-7/color-2 | 2 | 26/26 | 21883 | 23189 | PASS |
| position-7/color-2 | 4 | 345/345 | 23090 | 25653 | PASS |
| position-8/color-1 | 2 | 23/23 | 22658 | 23243 | PASS |
| position-8/color-1 | 4 | 64/64 | 22718 | 23668 | PASS |
| position-8/color-2 | 2 | 11/11 | 22348 | 22327 | PASS |
| position-8/color-2 | 4 | 56/56 | 24455 | 24335 | PASS |
| position-9/color-1 | 2 | 40/40 | 24253 | 26337 | PASS |
| position-9/color-1 | 4 | 137/137 | 21519 | 23160 | PASS |
| position-9/color-2 | 2 | 32/32 | 23151 | 24786 | PASS |
| position-9/color-2 | 4 | 246/246 | 21976 | 22309 | PASS |
| position-10/color-1 | 2 | 27/27 | 20971 | 23857 | PASS |
| position-10/color-1 | 4 | 164/164 | 23061 | 24591 | PASS |
| position-10/color-2 | 2 | 23/23 | 21199 | 24652 | PASS |
| position-10/color-2 | 4 | 122/122 | 22077 | 23352 | PASS |

## 生产 TS 引擎实测

直接调用 createSearchSession（hard），保留开局、VCF/PNS、反杀和 Alpha-Beta 流程。
生产引擎和固定深度原型策略不同，因此分别报告，不把节点吞吐差异当作棋力或速度提升。

| 局面 | 落点 | 完成深度 | 节点 | 耗时 ms | 预算 ms | NPS | 结束原因 |
|---|---|---:|---:|---:|---:|---:|---|
| position-1 | 6,8 | 10 | 272126 | 2999.77 | 3000 | 90716 | time |
| position-2 | 5,6 | 12 | 299536 | 2999.99 | 3000 | 99846 | time |
| position-3 | 4,3 | 10 | 280272 | 3000.08 | 3000 | 93421 | time |
| position-4 | 3,6 | 12 | 273828 | 3000.17 | 3000 | 91271 | time |
| position-5 | 11,6 | 10 | 285906 | 2999.96 | 3000 | 95303 | time |
| position-6 | 4,5 | 12 | 167952 | 3000.17 | 3000 | 55981 | time |
| position-7 | 7,9 | 0 | 7054 | 542.03 | 3000 | 13014 | depth |
| position-8 | 7,4 | 0 | 1 | 0.29 | 3000 | 3393 | depth |
| position-9 | 6,4 | 10 | 92057 | 2999.94 | 3000 | 30686 | time |
| position-10 | 10,8 | 10 | 88510 | 3000.05 | 3000 | 29503 | time |

该报告只记录本次执行的样本与测量；未测量 GC、分配次数、完整棋力或生产可用性，不据此声明零分配或生产就绪。
