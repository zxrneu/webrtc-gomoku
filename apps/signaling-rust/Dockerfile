# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Multi-stage build. Build context = **仓库根目录**（含前端构建阶段）：
#   docker buildx build --platform linux/amd64,linux/arm64 -t gomoku-signaling .
#
# 产物：单二进制 + 自包含前端静态资源（/app/public），镜像可独立运行：
#   docker compose up --build   # 或任意 context，见 docker-compose.yml
# ---------------------------------------------------------------------------
FROM rust:slim-bookworm AS builder
WORKDIR /build
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY apps/signaling-rust/Cargo.toml ./
COPY apps/signaling-rust/Cargo.lock ./
COPY apps/signaling-rust/src ./src
# --locked：依赖版本与仓库 Cargo.lock 逐字节锁定，构建可复现（F2）。
RUN cargo build --release --locked

# ---------------------------------------------------------------------------
# 前端构建阶段：用 workspace 锁定的 pnpm 工具链构建 packages/web。
# 产出 dist（vite build），最终打进运行时镜像的 /app/public。
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS webbuilder
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /build
# workspace 清单三件套 + 全部 workspace 包（与仓库内 `pnpm install` 行为一致，
# 保证 --frozen-lockfile 可复现）。tsconfig.base.json 供 esbuild 读取
# （packages/web/tsconfig.json 的 extends 目标）。
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tooling ./tooling
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @webrtc-gomoku/web build

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin appuser

WORKDIR /app
COPY --from=builder /build/target/release/gomoku-signaling /usr/local/bin/gomoku-signaling
COPY apps/signaling-rust/config.example.toml /app/config.example.toml
# 前端产物落在 /app/public：命中 resolve_public_dir 回退链 [配置值,
# packages/web/dist, dist, public] 的 "public" 候选（WORKDIR=/app），
# docker compose up 后浏览器打开 :3000 即可用（F1）。
COPY --from=webbuilder /build/packages/web/dist ./public

# Run as non-root.
USER appuser

ENV GOMOKU_HOST=0.0.0.0 \
    GOMOKU_PORT=3000 \
    GOMOKU_LOG_FORMAT=json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${GOMOKU_PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/gomoku-signaling"]
