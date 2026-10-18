/**
 * 人机模式的展示文案工具（纯函数，无 React）。
 *
 * 为什么单独成文件：难度文案同时被 `AiPanel`（下拉选项）与 `App`（对局信息区「AI（最强）」）
 * 使用，放在任一组件里都会造成跨组件反向依赖；集中在这里可保证文案唯一、不重复。
 */

import type { Difficulty, Point } from '@webrtc-gomoku/core';

/** 难度中文名（与 PRD §4 的「简单 / 普通 / 最强」一致） */
export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = Object.freeze({
  easy: '简单',
  normal: '普通',
  hard: '最强',
});

/** 难度下拉的展示顺序（由弱到强） */
export const DIFFICULTY_ORDER: readonly Difficulty[] = Object.freeze(['easy', 'normal', 'hard']);

/** 棋盘横轴字母表（A 到 O），与 Board / GameStatus 的坐标体系一致 */
const COLS = 'ABCDEFGHIJKLMNO';

/**
 * 把内部坐标转成棋谱可读坐标，例如 (7, 7) → "H8"。
 * @param point 坐标元组 [x, y]
 */
export function formatPoint(point: Point): string {
  const [x, y] = point;
  const col = COLS[x] ?? '?';
  return `${col}${15 - y}`;
}
