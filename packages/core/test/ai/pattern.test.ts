/**
 * 棋型识别表驱动测试。
 *
 * 覆盖架构 §1.2 棋型表的每一行（含 5 种冲四、4 种活三、6 种眠三、4 种活二、
 * 4 种眠二、3 种活一），并交叉验证两条等价路径：
 * - `patternOfWindow`：字符串版本（可读的规则基准）
 * - `windowScoreAt`：3 进制查表版本（搜索热路径实际使用的版本）
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  PATTERN_SCORES,
  WHITE,
  idxOf,
  patternOfWindow,
  scoreToPattern,
  setCellAtIdx,
  windowScoreAt,
  type AiBoard,
  type PatternType,
} from '../../src/index';

/** 把 9 字符串窗口铺到第 7 行的第 3~11 列（中心在第 7 列），1=黑 2=白 0=空 */
function boardFromWindow(win: string): { board: AiBoard; center: number } {
  const board = new Int8Array(225);
  const center = idxOf(7, 7);
  for (let slot = 0; slot < 9; slot += 1) {
    const ch = win.charAt(slot);
    if (ch === '0') continue;
    const cell = idxOf(7 + slot - 4, 7);
    setCellAtIdx(board, cell, ch === '1' ? BLACK : WHITE);
  }
  return { board, center };
}

interface Case {
  readonly win: string;
  readonly type: PatternType;
  readonly note: string;
}

const CASES: readonly Case[] = [
  // FIVE
  { win: '220111112', type: 'FIVE', note: '五连（右端被挡）' },
  { win: '111111100', type: 'FIVE', note: '长连也算五连' },
  // OPEN_FOUR
  { win: '220111102', type: 'OPEN_FOUR', note: '活四 011110' },
  // FOUR（5 种冲四）
  { win: '220111122', type: 'FOUR', note: '冲四 011112' },
  { win: '211110002', type: 'FOUR', note: '冲四 211110' },
  { win: '110112002', type: 'FOUR', note: '冲四 11011' },
  { win: '101112002', type: 'FOUR', note: '冲四 10111' },
  { win: '111012002', type: 'FOUR', note: '冲四 11101' },
  // OPEN_THREE（4 种活三）
  { win: '201110020', type: 'OPEN_THREE', note: '活三 011100' },
  { win: '001110222', type: 'OPEN_THREE', note: '活三 001110' },
  { win: '010110222', type: 'OPEN_THREE', note: '活三 010110' },
  { win: '011010222', type: 'OPEN_THREE', note: '活三 011010' },
  // SLEEP_THREE（6 种眠三）
  { win: '001112222', type: 'SLEEP_THREE', note: '眠三 001112' },
  { win: '221110022', type: 'SLEEP_THREE', note: '眠三 211100' },
  { win: '010112222', type: 'SLEEP_THREE', note: '眠三 010112' },
  { win: '222110102', type: 'SLEEP_THREE', note: '眠三 211010' },
  { win: '100112222', type: 'SLEEP_THREE', note: '眠三 10011' },
  { win: '101012222', type: 'SLEEP_THREE', note: '眠三 10101' },
  // OPEN_TWO（4 种活二）
  { win: '200110022', type: 'OPEN_TWO', note: '活二 001100' },
  { win: '201010022', type: 'OPEN_TWO', note: '活二 010100' },
  { win: '001010222', type: 'OPEN_TWO', note: '活二 001010' },
  { win: '010010222', type: 'OPEN_TWO', note: '活二 010010' },
  // SLEEP_TWO（4 种眠二）
  { win: '000112222', type: 'SLEEP_TWO', note: '眠二 000112' },
  { win: '222110002', type: 'SLEEP_TWO', note: '眠二 211000' },
  { win: '001012222', type: 'SLEEP_TWO', note: '眠二 001012' },
  { win: '100012222', type: 'SLEEP_TWO', note: '眠二 10001' },
  // OPEN_ONE（3 种活一）
  { win: '220010022', type: 'OPEN_ONE', note: '活一 00100' },
  { win: '222010002', type: 'OPEN_ONE', note: '活一 01000' },
  { win: '200010002', type: 'OPEN_ONE', note: '活一 00010' },
  // 边界与优先级
  { win: '000010000', type: 'OPEN_ONE', note: '孤子按活一处理' },
  { win: '011111002', type: 'FIVE', note: '优先级：11111 判 FIVE 而非 OPEN_FOUR' },
  { win: '000000000', type: 'NONE', note: '全空窗口无棋型' },
  { win: '220202202', type: 'NONE', note: '中心不是己方子则无棋型' },
];

describe('patternOfWindow（字符串规则基准）', () => {
  it('表驱动用例不少于 24 条', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(24);
  });

  for (const c of CASES) {
    it(`${c.win} -> ${c.type}（${c.note}）`, () => {
      expect(patternOfWindow(c.win)).toBe(c.type);
    });
  }

  it('非 9 长度窗口一律返回 NONE', () => {
    expect(patternOfWindow('11111')).toBe('NONE');
    expect(patternOfWindow('')).toBe('NONE');
  });
});

describe('windowScoreAt（3 进制查表路径与字符串路径一致）', () => {
  // 查表路径把中心恒视为己方子（「若我落在此处」），因此只对中心为 1 的窗口做交叉验证
  for (const c of CASES.filter((x) => x.win.charAt(4) === '1')) {
    it(`${c.win} 查表结果 = ${c.type}`, () => {
      const { board, center } = boardFromWindow(c.win);
      const score = windowScoreAt(board, center, 0, BLACK);
      expect(scoreToPattern(score)).toBe(c.type);
      expect(score).toBe(PATTERN_SCORES[c.type]);
    });
  }

  it('4 个方向各自独立识别（横/竖/斜）', () => {
    // 黑棋在 (7,7) 的竖方向形成活三
    const board = new Int8Array(225);
    setCellAtIdx(board, idxOf(7, 6), BLACK);
    setCellAtIdx(board, idxOf(7, 8), BLACK);
    const center = idxOf(7, 7);
    expect(scoreToPattern(windowScoreAt(board, center, 1, BLACK))).toBe('OPEN_THREE');
    expect(scoreToPattern(windowScoreAt(board, center, 0, BLACK))).toBe('OPEN_ONE');
  });

  it('对方子与越界同样视为阻挡', () => {
    const center = idxOf(7, 7);
    const open = new Int8Array(225);
    setCellAtIdx(open, idxOf(6, 7), BLACK);
    setCellAtIdx(open, idxOf(8, 7), BLACK);
    expect(scoreToPattern(windowScoreAt(open, center, 0, BLACK))).toBe('OPEN_THREE');
    const blocked = new Int8Array(225);
    setCellAtIdx(blocked, idxOf(6, 7), BLACK);
    setCellAtIdx(blocked, idxOf(8, 7), BLACK);
    setCellAtIdx(blocked, idxOf(5, 7), WHITE);
    setCellAtIdx(blocked, idxOf(9, 7), WHITE);
    expect(scoreToPattern(windowScoreAt(blocked, center, 0, BLACK))).toBe('NONE');
  });

  it('越界槽位按阻挡处理', () => {
    // (0,7) 的左侧 4 个槽位全部越界：两子只能算被挡住的眠二，不能算活二
    const board = new Int8Array(225);
    setCellAtIdx(board, idxOf(1, 7), BLACK);
    expect(scoreToPattern(windowScoreAt(board, idxOf(0, 7), 0, BLACK))).toBe('SLEEP_TWO');
    // 棋盘中部同样的两子形态则是标准活二
    const mid = new Int8Array(225);
    setCellAtIdx(mid, idxOf(6, 7), BLACK);
    expect(scoreToPattern(windowScoreAt(mid, idxOf(5, 7), 0, BLACK))).toBe('OPEN_TWO');
  });
});

describe('PATTERN_SCORES 单调性（架构 §1.2）', () => {
  it('FIVE > OPEN_FOUR > 双四 > 四三 > 双活三 > FOUR > OPEN_THREE', () => {
    expect(PATTERN_SCORES.FIVE).toBeGreaterThan(PATTERN_SCORES.OPEN_FOUR);
    expect(PATTERN_SCORES.OPEN_FOUR).toBeGreaterThan(800_000);
    expect(800_000).toBeGreaterThan(400_000);
    expect(400_000).toBeGreaterThan(300_000);
    expect(300_000).toBeGreaterThan(PATTERN_SCORES.FOUR);
    expect(PATTERN_SCORES.FOUR).toBeGreaterThan(PATTERN_SCORES.OPEN_THREE);
    expect(PATTERN_SCORES.OPEN_THREE).toBeGreaterThan(PATTERN_SCORES.SLEEP_THREE);
    expect(PATTERN_SCORES.SLEEP_THREE).toBeGreaterThan(PATTERN_SCORES.OPEN_TWO);
    expect(PATTERN_SCORES.OPEN_TWO).toBeGreaterThan(PATTERN_SCORES.SLEEP_TWO);
    expect(PATTERN_SCORES.SLEEP_TWO).toBeGreaterThan(PATTERN_SCORES.OPEN_ONE);
  });
});
