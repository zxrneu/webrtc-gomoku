/**
 * 重连能力（Reconnect）公共出口
 *
 * 分层：本目录全部是**纯逻辑**，零 IO / 零 DOM / 零全局时钟。
 * 浏览器适配器在 `packages/web/src/connection/*`，服务端适配器在 `apps/server/src/*`。
 */

export * from './ports';
export * from './policy';
export * from './classify';
export * from './heartbeat';
export * from './sync';
export * from './state';
export * from './status';
export * from './log';
export * from './orchestrator';
