import { SIZE } from '@webrtc-gomoku/core';

/**
 * 棋盘几何常量与坐标换算（Canvas 逻辑像素，与 CSS 缩放解耦）
 *
 * 设计约束（由 boardGeometry.test.ts 守住）：
 * 1. 画布分辨率固定 560，CSS 尺寸与视觉基线不随改动漂移；
 * 2. 边距 PAD 必须同时容纳「坐标刻度 + 棋子半径」且二者不重叠——
 *    旧值 PAD=28 时棋子顶边 12.16px 会盖住基线 12px 的刻度文字，首行棋子压字；
 * 3. 相邻棋子之间保留至少 4px 网格间隙，避免视觉粘连。
 */

/** 每个网格间距（像素） */
export const CELL = 34;

/** 棋盘边缘留白：42px 足以容纳 14px 刻度（内缩 14px）与 14.96px 棋子半径 */
export const PAD = 42;

/** Canvas 渲染视口的物理分辨率（(15-1)*34 + 42*2 = 560，与历史截图基线一致） */
export const CANVAS_SIZE = (SIZE - 1) * CELL + PAD * 2;

/** 棋子半径：略小于半格，避免相邻棋子贴合 */
export const STONE_RADIUS = CELL * 0.44;

/** 坐标刻度字号与距画布边缘的内缩距离（居中于棋子外侧的留白带） */
export const LABEL_FONT_SIZE = 14;
export const LABEL_INSET = 14;

/** 水平横轴坐标标记字母表（A 到 O，共 15 列） */
export const COLS = 'ABCDEFGHIJKLMNO';

/** 交叉点索引 → 画布像素中心点 */
export function pointToPixel(x: number, y: number): { px: number; py: number } {
  return { px: PAD + x * CELL, py: PAD + y * CELL };
}

/**
 * 画布像素 → 最近的交叉点索引（磁吸）。
 * 半格以内的边缘外点击仍然命中，超出半格或落在盘外返回 null。
 */
export function pixelToPoint(px: number, py: number): { x: number; y: number } | null {
  const x = Math.round((px - PAD) / CELL) || 0; // `|| 0` 把 -0 归一化为 0
  const y = Math.round((py - PAD) / CELL) || 0;
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  return { x, y };
}
