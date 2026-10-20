# 文档导航

项目介绍、构建与运行见[项目 README](../README.md)，开发规范见 [AGENTS.md](../AGENTS.md)，后续功能范围见[路线图](../ROADMAP.md)。

## 使用与部署

| 文档 | 用途 |
| --- | --- |
| [快速开始](../README.md#快速开始与本地开发) | 工具链、首次安装、构建与双终端开发 |
| [聊天与富媒体](chat-media.md) | 图片、文件、语音、接收确认、保存和会话边界 |
| [HTTPS 与语音](https.md) | 一键生成局域网证书、设备信任、Vite / Node / Rust HTTPS |
| [公网重建与恢复](production-recovery.md) | Linux 发布包、systemd 模板、IP 证书与续签、升级和迁移 |
| [阿里云运维](aliyun-operations.md) | 公网证书签发与续签、服务管理、部署与回滚 |
| [TURN 配置](turn.md) | coturn 中继、ICE 配置与真实连接验收 |
| [Rust 服务](../apps/signaling-rust/README.md) / [部署指南](m3-rust-signaling/deploy.md) | 原生运行、Docker、配置、监控与上线检查 |
| [Node 服务](../apps/server/README.md) | 运行、信令协议与环境变量 |
| [服务大厅](m6-lobby/README.md) | 邀请、匹配、公开房间、运行边界与测试命令 |

## 开发与设计

| 主题 | 文档 |
| --- | --- |
| 测试与兼容性 | [环境准备、Node / Rust 回归与浏览器矩阵](testing.md) |
| Web 前端 | [模块说明](../packages/web/README.md) |
| Rust 信令 | [需求](m3-rust-signaling/prd.md)、[架构](m3-rust-signaling/architecture.md) |
| 自动重连 | [需求](reconnect/prd.md)、[架构](reconnect/architecture.md) |
| 服务大厅 | [需求与交互](m6-lobby/prd.md) |
| AI 引擎 | [能力与运行方式](m5-ai/engine-upgrade.md)、[需求](m5-ai/prd.md)、[架构](m5-ai/architecture.md) |
| AI 性能 | [优化目标](ai-perf/prd.md)、[可复现基准](m5-ai/differential-benchmark-report.md) |
| 胜法证书 | [输入样例](m5-ai/examples/double-three.input.json)、[证明样例](m5-ai/examples/double-three.proof.json) |

## 维护约定

文档记录当前功能、约束、接口与可复现的操作步骤。实现细节以源码和测试为准；基准报告与原始数据成对维护。发版流水、一次性验收、任务勾选和临时审查结果不作为项目文档保存。
