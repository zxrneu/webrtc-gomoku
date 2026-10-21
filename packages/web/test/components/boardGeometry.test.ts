import { describe, expect, it } from 'vitest';
import { SIZE } from '@webrtc-gomoku/core';
import {
  CANVAS_SIZE,
  CELL,
  LABEL_FONT_SIZE,
  LABEL_INSET,
  PAD,
  STONE_RADIUS,
  pixelToPoint,
  pointToPixel,
} from '../../src/components/Board/geometry';

describe('棋盘几何', () => {
  it('画布分辨率保持 560，CSS 尺寸与截图基线不变', () => {
    expect(CANVAS_SIZE).toBe(560);
    expect(CANVAS_SIZE).toBe((SIZE - 1) * CELL + PAD * 2);
  });

  it('首行棋子的上边缘不覆盖坐标刻度', () => {
    const stoneTop = PAD - STONE_RADIUS;
    const labelBottom = LABEL_INSET + LABEL_FONT_SIZE / 2;
    expect(stoneTop - labelBottom).toBeGreaterThanOrEqual(6);
  });

  it('缩小到 320px 宽棋盘时坐标字号仍至少为 8px', () => {
    const displayedBoardWidth = 320;
    const displayedFontSize = LABEL_FONT_SIZE * displayedBoardWidth / CANVAS_SIZE;

    expect(displayedFontSize).toBeGreaterThanOrEqual(8);
  });

  it('相邻棋子之间留出网格间隙，不互相贴合', () => {
    expect(CELL - STONE_RADIUS * 2).toBeGreaterThanOrEqual(4);
  });

  it('最后一列与最后一行的棋子完全落在画布内', () => {
    const { px, py } = pointToPixel(SIZE - 1, SIZE - 1);
    expect(px + STONE_RADIUS).toBeLessThan(CANVAS_SIZE);
    expect(py + STONE_RADIUS).toBeLessThan(CANVAS_SIZE);
  });

  it.each([
    [0, 0],
    [7, 7],
    [3, 11],
    [SIZE - 1, SIZE - 1],
  ])('交叉点 (%i, %i) 与像素坐标可逆往返', (x, y) => {
    const { px, py } = pointToPixel(x, y);
    expect(pixelToPoint(px, py)).toEqual({ x, y });
  });

  it('四角外侧半格内仍可命中，超出半格即拒绝', () => {
    expect(pixelToPoint(PAD - CELL / 2 + 1, PAD - CELL / 2 + 1)).toEqual({ x: 0, y: 0 });
    expect(pixelToPoint(PAD + CELL, PAD)).toEqual({ x: 1, y: 0 });
    expect(pixelToPoint(PAD - CELL, PAD)).toBeNull();
    expect(pixelToPoint(PAD + CELL * SIZE, PAD)).toBeNull();
  });

  it('越界像素不会吸附到盘外交叉点', () => {
    expect(pixelToPoint(0, 0)).toBeNull();
    expect(pixelToPoint(CANVAS_SIZE, CANVAS_SIZE)).toBeNull();
  });
});
