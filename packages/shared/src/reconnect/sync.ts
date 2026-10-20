/**
 * ============================================================================
 * 棋谱对账（房主权威 + 确定性重放校验）
 * ============================================================================
 * 恢复连接后双方可能各自持有不同棋谱：
 * - 房主（offerer）是**唯一权威**（D3 已拍板）；
 * - 加入方无条件采纳房主的棋谱，即使本地更多手（本地多出来的手视为未送达）；
 * - 采纳前必须用 `core.applyMove` 逐手重放校验，**绝不信任对端数据**（K6-12）。
 */

import type { GameState, Move } from '@webrtc-gomoku/core';
import { applyMove, create as createGame, SIZE } from '@webrtc-gomoku/core';

/** 对账方案 */
export interface SyncPlan {
  /** 本端是否为权威方（房主） */
  authoritative: boolean;
  /** 采用后的完整棋谱（房主=自己的；加入方=收到的） */
  adopt: readonly Move[];
  /** 加入方相比本地新增的手数 */
  appended: number;
  /** 是否发现分叉（本地与权威不一致，或权威数据非法） */
  mismatch: boolean;
}

/** 重放结果 */
export type ReplayResult = { ok: true; game: GameState } | { ok: false; at: number };

function isMove(value: unknown): value is Move {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const move = value as Record<string, unknown>;
  return typeof move.x === 'number' && Number.isInteger(move.x) && move.x >= 0 && move.x < SIZE &&
    typeof move.y === 'number' && Number.isInteger(move.y) && move.y >= 0 && move.y < SIZE &&
    (move.c === 1 || move.c === 2);
}

/**
 * 用 `core.applyMove` 确定性重放一份棋谱，先校验外部字段再逐手检查规则。
 *
 * @param moves 待校验的棋谱
 * @returns 成功返回终局状态；失败返回第一手非法落子的**下标**（从 0 开始）
 */
export function replayMoves(moves: readonly unknown[]): ReplayResult {
  const game = createGame();
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index];
    if (!isMove(move)) return { ok: false, at: index };
    const result = applyMove(game, move.x, move.y, move.c);
    if (!result.ok) return { ok: false, at: index };
  }
  return { ok: true, game };
}

/** 计算两份棋谱的公共前缀长度 */
function commonPrefixLength(a: readonly Move[], b: readonly Move[]): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return i;
    if (left.x !== right.x || left.y !== right.y || left.c !== right.c) return i;
  }
  return limit;
}

/**
 * 生成对账方案。
 *
 * - 房主：`authoritative=true`，`adopt` 就是本地棋谱（永不采纳对端数据）；
 * - 加入方：先校验 `incoming`（重放），非法则拒绝采纳并标记 `mismatch`；
 *   合法则整体替换为 `incoming`（房主权威）。
 */
export function planSync(params: {
  role: 'host' | 'guest';
  local: readonly Move[];
  incoming?: readonly Move[];
}): SyncPlan {
  const { role, local, incoming } = params;

  if (role === 'host') {
    return { authoritative: true, adopt: local, appended: 0, mismatch: false };
  }

  if (!incoming) {
    return { authoritative: false, adopt: local, appended: 0, mismatch: false };
  }

  // 不信任对端数据：脏数据一律拒绝采纳，保留本地
  const replay = replayMoves(incoming);
  if (!replay.ok) {
    return { authoritative: false, adopt: local, appended: 0, mismatch: true };
  }

  const common = commonPrefixLength(local, incoming);
  const localIsPrefix = common === local.length;
  const appended = localIsPrefix ? incoming.length - local.length : Math.max(0, incoming.length - common);

  return {
    authoritative: false,
    adopt: incoming,
    appended,
    mismatch: !localIsPrefix,
  };
}
