/**
 * 棋型识别。
 *
 * 方案：对「落子点 + 4 个方向」各取长度 9 的窗口（中心固定为落子点，越界与对方子
 * 统一记为 2），把窗口编码成 3 进制整数后查表。查表把「一次棋型判定」从
 * 数十次字符串比较压成一次数组读取，是 1s 内跑完 8~9 层的性能基础。
 * 表由 PATTERN_TABLE 枚举生成，`patternOfWindow` 提供等价的字符串版本供测试交叉验证。
 */

import type { AiBoard, PlayerColor } from './types';
import { AI_CELLS, AI_DIRS, AI_SIZE, idxOf, xOf, yOf } from './types';

/** 棋型枚举；NONE 表示该方向没有形成任何可识别棋型 */
export type PatternType =
  | 'NONE'
  | 'FIVE'
  | 'OPEN_FOUR'
  | 'FOUR'
  | 'OPEN_THREE'
  | 'SLEEP_THREE'
  | 'OPEN_TWO'
  | 'SLEEP_TWO'
  | 'OPEN_ONE';

/**
 * 棋型分值表（架构 §1.2）。
 * 顺序必须满足 FIVE > OPEN_FOUR > 双四 > 四三 > 双活三 > FOUR > OPEN_THREE。
 * 同时以本地常量形式再声明一份：`combineScores` 在热路径上，读冻结对象属性太慢。
 */
const S_FIVE = 10_000_000;
const S_OPEN_FOUR = 1_000_000;
const S_FOUR = 100_000;
const S_OPEN_THREE = 20_000;
const S_SLEEP_THREE = 5_000;
const S_OPEN_TWO = 800;
const S_SLEEP_TWO = 120;
const S_OPEN_ONE = 20;

/** 棋型分值表（对外只读视图） */
export const PATTERN_SCORES: Readonly<Record<PatternType, number>> = Object.freeze({
  NONE: 0,
  FIVE: S_FIVE,
  OPEN_FOUR: S_OPEN_FOUR,
  FOUR: S_FOUR,
  OPEN_THREE: S_OPEN_THREE,
  SLEEP_THREE: S_SLEEP_THREE,
  OPEN_TWO: S_OPEN_TWO,
  SLEEP_TWO: S_SLEEP_TWO,
  OPEN_ONE: S_OPEN_ONE,
});

/** 双四（含活四参与）的覆盖分值 */
export const COMBO_DOUBLE_FOUR = 800_000;

/** 四三的覆盖分值 */
export const COMBO_FOUR_THREE = 400_000;

/** 双活三的覆盖分值 */
export const COMBO_DOUBLE_THREE = 300_000;

/** 一条棋型规则：窗口模式串 + 棋型类别 */
export interface PatternEntry {
  readonly pattern: string;
  readonly type: PatternType;
}

/**
 * 棋型优先级表：数组顺序即优先级，命中即返回。
 * `1`=己方 `0`=空 `2`=阻挡（对方子或越界）。
 */
export const PATTERN_TABLE: readonly PatternEntry[] = Object.freeze([
  { pattern: '11111', type: 'FIVE' },
  { pattern: '011110', type: 'OPEN_FOUR' },
  { pattern: '011112', type: 'FOUR' },
  { pattern: '211110', type: 'FOUR' },
  { pattern: '11011', type: 'FOUR' },
  { pattern: '10111', type: 'FOUR' },
  { pattern: '11101', type: 'FOUR' },
  { pattern: '011100', type: 'OPEN_THREE' },
  { pattern: '001110', type: 'OPEN_THREE' },
  { pattern: '010110', type: 'OPEN_THREE' },
  { pattern: '011010', type: 'OPEN_THREE' },
  { pattern: '001112', type: 'SLEEP_THREE' },
  { pattern: '211100', type: 'SLEEP_THREE' },
  { pattern: '010112', type: 'SLEEP_THREE' },
  { pattern: '211010', type: 'SLEEP_THREE' },
  { pattern: '10011', type: 'SLEEP_THREE' },
  { pattern: '10101', type: 'SLEEP_THREE' },
  { pattern: '001100', type: 'OPEN_TWO' },
  { pattern: '010100', type: 'OPEN_TWO' },
  { pattern: '001010', type: 'OPEN_TWO' },
  { pattern: '010010', type: 'OPEN_TWO' },
  { pattern: '000112', type: 'SLEEP_TWO' },
  { pattern: '211000', type: 'SLEEP_TWO' },
  { pattern: '001012', type: 'SLEEP_TWO' },
  { pattern: '10001', type: 'SLEEP_TWO' },
  { pattern: '00100', type: 'OPEN_ONE' },
  { pattern: '01000', type: 'OPEN_ONE' },
  { pattern: '00010', type: 'OPEN_ONE' },
]);

/** 窗口长度 */
const WINDOW_LEN = 9;

/** 中心槽位下标 */
const CENTER_SLOT = 4;

/** 方向数（AI_DIRS 长度快照，热循环里避免跨模块绑定访问） */
const DIR_COUNT = 4;

/** 格子总数快照（同上） */
const CELL_TOTAL = AI_CELLS;

/**
 * 3 的幂，用于窗口的 3 进制编码。
 * 用 Int32Array 而非冻结数组：冻结数组在 V8 里会被降级为慢速元素访问，
 * 实测窗口扫描会因此慢一倍（这是搜索热路径，必须避开）。
 */
const THREE_POW = new Int32Array([1, 3, 9, 27, 81, 243, 729, 2187, 6561]);

/** 中心槽位的固定权重 3^4（中心恒视为己方子） */
const CENTER_WEIGHT = 81;

/** 3^9 个可能的窗口编码 */
const WINDOW_CODE_COUNT = 19683;

/**
 * 由 PATTERN_TABLE 枚举出「窗口编码 -> 棋型分」查找表。
 *
 * 枚举而非逐码解码：每个模式的通配位只有 3~4 个，总写入约 1.3 万次，
 * 模块初始化开销可忽略。从低优先级往高优先级写，后者覆盖前者即得到优先级语义。
 * 只有当「模式落在中心槽位上的字符是 1」时才枚举——中心必须是己方子。
 */
function buildWindowScores(): Int32Array {
  const table = new Int32Array(WINDOW_CODE_COUNT);
  for (let pi = PATTERN_TABLE.length - 1; pi >= 0; pi -= 1) {
    const entry = PATTERN_TABLE[pi];
    if (entry === undefined) continue;
    const pat = entry.pattern;
    const len = pat.length;
    const score = PATTERN_SCORES[entry.type];
    for (let start = 0; start + len <= WINDOW_LEN; start += 1) {
      const centerOffset = CENTER_SLOT - start;
      if (centerOffset < 0 || centerOffset >= len) continue;
      if (pat.charAt(centerOffset) !== '1') continue;
      const freeSlots: number[] = [];
      for (let slot = 0; slot < WINDOW_LEN; slot += 1) {
        if (slot < start || slot >= start + len) freeSlots.push(slot);
      }
      const combos = Math.pow(3, freeSlots.length);
      for (let m = 0; m < combos; m += 1) {
        let code = 0;
        let rest = m;
        for (let k = 0; k < len; k += 1) {
          code += (pat.charCodeAt(k) - 48) * (THREE_POW[start + k] ?? 0);
        }
        for (const slot of freeSlots) {
          const digit = rest % 3;
          rest = (rest - digit) / 3;
          code += digit * (THREE_POW[slot] ?? 0);
        }
        table[code] = score;
      }
    }
  }
  return table;
}

/** 窗口编码 -> 棋型分（0 表示 NONE） */
const WINDOW_SCORES = buildWindowScores();

/** 每个 (格子, 方向, 槽位) 对应的绝对索引；-1 表示越界 */
const WINDOW_INDEX = buildWindowIndex();

function buildWindowIndex(): Int16Array {
  const out = new Int16Array(CELL_TOTAL * DIR_COUNT * WINDOW_LEN);
  for (let idx = 0; idx < CELL_TOTAL; idx += 1) {
    const x = xOf(idx);
    const y = yOf(idx);
    for (let d = 0; d < DIR_COUNT; d += 1) {
      const dir = AI_DIRS[d];
      if (dir === undefined) continue;
      const base = (idx * DIR_COUNT + d) * WINDOW_LEN;
      for (let k = -CENTER_SLOT; k <= CENTER_SLOT; k += 1) {
        const nx = x + dir[0] * k;
        const ny = y + dir[1] * k;
        const inside = nx >= 0 && ny >= 0 && nx < AI_SIZE && ny < AI_SIZE;
        out[base + k + CENTER_SLOT] = inside ? idxOf(nx, ny) : -1;
      }
    }
  }
  return out;
}

/**
 * 窗口读取器：与 `cellAtIdx` 同属唯一封装族（这里仍是「一个收窄 + 一个默认值」），
 * 只是去掉了边界分支——`WINDOW_INDEX` 已用 -1 标记越界，调用方先判空。
 * 之所以在本模块内再封一层：跨模块调用实测比本地内联慢一个数量级，
 * 而窗口扫描是每次搜索节点执行数百次的热循环。
 */
function readCell(b: AiBoard, at: number): number {
  return b[at] ?? 0;
}

/**
 * 字符串版的棋型判定（测试基准）。
 * 中心不是己方子时返回 NONE——因为「经过该点的棋型」必须包含该点。
 */
export function patternOfWindow(win: string): PatternType {
  if (win.length !== WINDOW_LEN) return 'NONE';
  if (win.charAt(CENTER_SLOT) !== '1') return 'NONE';
  for (const entry of PATTERN_TABLE) {
    const len = entry.pattern.length;
    for (let start = 0; start + len <= WINDOW_LEN; start += 1) {
      if (start > CENTER_SLOT || start + len - 1 < CENTER_SLOT) continue;
      if (win.substr(start, len) === entry.pattern) return entry.type;
    }
  }
  return 'NONE';
}

/** 计算某格在某方向上的窗口 3 进制编码（中心恒视为己方子） */
export function windowCode(b: AiBoard, idx: number, dir: number, color: PlayerColor): number {
  const base = (idx * DIR_COUNT + dir) * WINDOW_LEN;
  let code = CENTER_WEIGHT; // 中心槽位恒为己方子（3^4）
  for (let slot = 0; slot < WINDOW_LEN; slot += 1) {
    if (slot === CENTER_SLOT) continue;
    const at = WINDOW_INDEX[base + slot] ?? -1;
    if (at < 0) {
      code += 2 * (THREE_POW[slot] ?? 0);
      continue;
    }
    const v = readCell(b, at);
    if (v === 0) continue;
    code += (v === color ? 1 : 2) * (THREE_POW[slot] ?? 0);
  }
  return code;
}

/** 某格某方向的棋型分 */
export function windowScoreAt(b: AiBoard, idx: number, dir: number, color: PlayerColor): number {
  return WINDOW_SCORES[windowCode(b, idx, dir, color)] ?? 0;
}

/** 分值反查棋型（分值互不相同，可无损映射） */
export function scoreToPattern(score: number): PatternType {
  if (score === PATTERN_SCORES.FIVE) return 'FIVE';
  if (score === PATTERN_SCORES.OPEN_FOUR) return 'OPEN_FOUR';
  if (score === PATTERN_SCORES.FOUR) return 'FOUR';
  if (score === PATTERN_SCORES.OPEN_THREE) return 'OPEN_THREE';
  if (score === PATTERN_SCORES.SLEEP_THREE) return 'SLEEP_THREE';
  if (score === PATTERN_SCORES.OPEN_TWO) return 'OPEN_TWO';
  if (score === PATTERN_SCORES.SLEEP_TWO) return 'SLEEP_TWO';
  if (score === PATTERN_SCORES.OPEN_ONE) return 'OPEN_ONE';
  return 'NONE';
}

/** 某格某方向的棋型类别 */
export function patternAt(b: AiBoard, idx: number, dir: number, color: PlayerColor): PatternType {
  return scoreToPattern(windowScoreAt(b, idx, dir, color));
}

/**
 * 4 个方向的分值合并为单点分（组合威胁覆盖单点分值）。
 * 这是「会算杀、不送棋」的核心：双四 / 四三 / 双活三 会被显著抬价，
 * 让走法排序与叶节点评估都能立刻看到复合威胁。
 */
export function combineScores(d0: number, d1: number, d2: number, d3: number): number {
  // 手写展开而非遍历数组/闭包：该函数在搜索热路径上，任何每调用分配都会拖慢节点吞吐
  let five = 0;
  let openFour = 0;
  let four = 0;
  let openThree = 0;
  let best = 0;
  let s = d0;
  if (s > best) best = s;
  if (s === S_FIVE) five += 1;
  else if (s === S_OPEN_FOUR) openFour += 1;
  else if (s === S_FOUR) four += 1;
  else if (s === S_OPEN_THREE) openThree += 1;
  s = d1;
  if (s > best) best = s;
  if (s === S_FIVE) five += 1;
  else if (s === S_OPEN_FOUR) openFour += 1;
  else if (s === S_FOUR) four += 1;
  else if (s === S_OPEN_THREE) openThree += 1;
  s = d2;
  if (s > best) best = s;
  if (s === S_FIVE) five += 1;
  else if (s === S_OPEN_FOUR) openFour += 1;
  else if (s === S_FOUR) four += 1;
  else if (s === S_OPEN_THREE) openThree += 1;
  s = d3;
  if (s > best) best = s;
  if (s === S_FIVE) five += 1;
  else if (s === S_OPEN_FOUR) openFour += 1;
  else if (s === S_FOUR) four += 1;
  else if (s === S_OPEN_THREE) openThree += 1;
  if (five > 0) return S_FIVE;
  if (openFour > 0) return S_OPEN_FOUR;
  if (four >= 2) return COMBO_DOUBLE_FOUR;
  if (four >= 1 && openThree >= 1) return COMBO_FOUR_THREE;
  if (openThree >= 2) return COMBO_DOUBLE_THREE;
  return best;
}

/**
 * 单点棋型分：假设 `color` 落在 `idx` 上，4 方向合并后的价值。
 * 对空点调用即「候选点评分」，对已占点调用即「该子的贡献分」。
 */
export function pointScore(b: AiBoard, idx: number, color: PlayerColor): number {
  return combineScores(
    windowScoreAt(b, idx, 0, color),
    windowScoreAt(b, idx, 1, color),
    windowScoreAt(b, idx, 2, color),
    windowScoreAt(b, idx, 3, color),
  );
}
