/**
 * 人机对战棋局操作（纯函数层）。
 *
 * 设计约束（架构 §6 / tasks.md T04）：
 * 1. **无 React / 无 DOM / 无 IO**：可直接单测，也可被任何视图层复用；
 * 2. **禁止自研胜负判定**：胜负 / 平局 / 落子合法性全部来自 core 的 `applyMove`，
 *    本文件只做「不可变克隆 + 守卫」两件事（PRD P0-6 代码审查项）；
 * 3. **不可变**：每次操作返回新 `GameState`，旧对象不被改写，
 *    这样 React 的 `useState` 比较引用即可判断是否真的变了。
 */

import type { GameState, Move, PlayerColor, Point } from '@webrtc-gomoku/core';
import { applyMove, create, currentColor, otherColor, undo } from '@webrtc-gomoku/core';

/**
 * 落子被拒绝的原因。
 *
 * `thinking` 是本层新增的守卫（AI 思考期禁落子，PRD P0-4），
 * 其余四种与 core 的 `MoveResult['reason']` 一一对应，避免调用点做二次翻译。
 */
export type AiMoveReason = 'thinking' | 'game-over' | 'not-your-turn' | 'occupied' | 'out-of-board';

/** 一次落子尝试的结果：失败时 `game` 原样返回，保证「点击 0 变更」 */
export type AiMoveOutcome =
  | { readonly ok: true; readonly game: GameState; readonly event: 'move' | 'win' | 'draw' }
  | { readonly ok: false; readonly game: GameState; readonly reason: AiMoveReason };

/**
 * 创建一局全新的人机对战棋局。
 * @returns 空棋盘的 `GameState`（黑方先行，由 core 决定）
 */
export function createAiGame(): GameState {
  return create();
}

/**
 * 深拷贝棋局，保证纯函数语义。
 * @param g 源棋局
 * @returns 与源棋局完全等价但互不共享引用的新棋局
 */
export function cloneGame(g: GameState): GameState {
  return {
    size: g.size,
    board: g.board.map((row) => [...row]),
    moves: g.moves.map((m) => ({ x: m.x, y: m.y, c: m.c })),
    over: g.over,
    winLine: g.winLine === null ? null : g.winLine.map((p): Point => [p[0], p[1]]),
  };
}

/**
 * AI 执子颜色 = 玩家执子的反面。
 * @param playerColor 玩家执子颜色
 */
export function aiColorOf(playerColor: PlayerColor): PlayerColor {
  return otherColor(playerColor);
}

/**
 * 统计某一方在盘面上的棋子数量（用于「我方还没落过子 → 不可悔棋」）。
 * @param g 棋局
 * @param color 待统计的颜色
 */
export function stoneCount(g: GameState, color: PlayerColor): number {
  let count = 0;
  for (const m of g.moves) {
    if (m.c === color) count += 1;
  }
  return count;
}

/**
 * 是否轮到某一方落子（终局时一律为 false）。
 * @param g 棋局
 * @param color 待判断的颜色
 */
export function isTurnOf(g: GameState, color: PlayerColor): boolean {
  return !g.over && currentColor(g) === color;
}

/** 是否轮到玩家落子（视图派生 `isMyTurn` 的唯一来源） */
export function isPlayerTurn(g: GameState, playerColor: PlayerColor): boolean {
  return isTurnOf(g, playerColor);
}

/**
 * 在克隆出的新棋局上落子，并把 core 的拒绝原因透传出去。
 * @param g 棋局
 * @param x 横坐标
 * @param y 纵坐标
 * @param color 落子方颜色
 */
function tryMove(g: GameState, x: number, y: number, color: PlayerColor): AiMoveOutcome {
  if (g.over) return { ok: false, game: g, reason: 'game-over' };
  if (currentColor(g) !== color) return { ok: false, game: g, reason: 'not-your-turn' };
  const next = cloneGame(g);
  const res = applyMove(next, x, y, color);
  if (!res.ok) return { ok: false, game: g, reason: res.reason };
  return { ok: true, game: next, event: res.event };
}

/**
 * 玩家落子。
 *
 * 守卫顺序即优先级：思考中 > 终局 > 非玩家回合 > 已被占（由 core 判定）。
 * 思考中直接返回原棋局对象，因此「连点 10 次 moves.length 不变」是结构性保证，
 * 而不是依赖 UI 的 `disabled`（PRD P0-4）。
 *
 * @param g 棋局
 * @param x 横坐标
 * @param y 纵坐标
 * @param playerColor 玩家执子颜色
 * @param thinking AI 是否正在思考
 */
export function playPlayerMove(
  g: GameState,
  x: number,
  y: number,
  playerColor: PlayerColor,
  thinking = false,
): AiMoveOutcome {
  if (thinking) return { ok: false, game: g, reason: 'thinking' };
  return tryMove(g, x, y, playerColor);
}

/**
 * AI 落子。
 * @param g 棋局
 * @param x 横坐标
 * @param y 纵坐标
 * @param aiColor AI 执子颜色
 */
export function playAiMove(g: GameState, x: number, y: number, aiColor: PlayerColor): AiMoveOutcome {
  return tryMove(g, x, y, aiColor);
}

/**
 * 是否允许悔棋。
 *
 * 规则（PRD P0-5 / US-4）：一次退两步（AI + 我），必须回到玩家回合；
 * 因此要求「我方至少落过一子」「总手数 ≥ 2」「当前正好轮到玩家」「未终局且不在思考期」。
 * 终局禁止悔棋与联机路径保持一致（联机侧 `disabled={!connected || over || !canUndo}`）。
 *
 * @param g 棋局
 * @param playerColor 玩家执子颜色
 * @param thinking AI 是否正在思考
 */
export function canUndoPair(g: GameState, playerColor: PlayerColor, thinking = false): boolean {
  if (thinking) return false;
  if (g.over) return false;
  if (g.moves.length < 2) return false;
  if (stoneCount(g, playerColor) === 0) return false;
  return currentColor(g) === playerColor;
}

/**
 * 悔棋：一次撤销两步（AI 的应手 + 玩家自己的一手）。
 *
 * 为什么退两步而不是一步：玩家只关心「让我重想一手」，
 * 退一步会把回合交回 AI，AI 立刻重下同一手（架构 §10.1），体验上等于没退。
 *
 * @param g 棋局
 * @param playerColor 玩家执子颜色
 * @param thinking AI 是否正在思考
 * @returns 悔棋后的新棋局；不满足条件时原样返回
 */
export function undoPair(g: GameState, playerColor: PlayerColor, thinking = false): GameState {
  if (!canUndoPair(g, playerColor, thinking)) return g;
  const next = cloneGame(g);
  undo(next);
  undo(next);
  return next;
}

/**
 * 取某一方的最后一手（用于 AI 落子高亮 / 面板信息）。
 * @param g 棋局
 * @param color 目标颜色
 */
export function lastMoveOf(g: GameState, color: PlayerColor): Move | null {
  for (let i = g.moves.length - 1; i >= 0; i -= 1) {
    const m = g.moves[i];
    if (m !== undefined && m.c === color) return { x: m.x, y: m.y, c: m.c };
  }
  return null;
}
