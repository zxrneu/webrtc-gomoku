/**
 * Zobrist 置换表哈希。
 *
 * 为什么用固定种子 xorshift32 而不是系统随机源：
 * core 内禁止任何非确定性输入（架构 §8.1），固定种子能保证「同局面同参数必同结果」，
 * 这是分片搜索不抖动、单测可复现的前提。
 */

import type { AiBoard, PlayerColor } from './types';
import { AI_CELLS, AI_BLACK, cellAtIdx } from './types';

/** 低位种子（架构 §4 指定） */
export const SEED_LO = 0x1f123bb5;

/** 高位种子（架构 §4 指定） */
export const SEED_HI = 0x9e3779b9;

/** 64 位哈希拆成两个 32 位整数，避免 BigInt 带来的性能损失 */
export interface ZobristTables {
  /** 长度 AI_CELLS * 2，索引 = idx * 2 + (color - 1) */
  readonly lo: Int32Array;
  /** 同上，高位 */
  readonly hi: Int32Array;
  /** 轮到白方时混入的低位常数 */
  readonly sideLo: number;
  /** 轮到白方时混入的高位常数 */
  readonly sideHi: number;
}

/** 单步 xorshift32；入参 0 会退化为恒定 0，故调用方必须给非零种子 */
function xorshift32(state: number): number {
  let x = state | 0;
  x ^= x << 13;
  x |= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x |= 0;
  return x;
}

/** 用给定种子生成完整张量（导出以便测试「同种子两次生成完全相同」） */
export function buildZobristTables(seedLo: number, seedHi: number): ZobristTables {
  const lo = new Int32Array(AI_CELLS * 2);
  const hi = new Int32Array(AI_CELLS * 2);
  let sLo = seedLo | 0;
  let sHi = seedHi | 0;
  for (let i = 0; i < AI_CELLS * 2; i += 1) {
    sLo = xorshift32(sLo);
    sHi = xorshift32(sHi);
    lo[i] = sLo;
    hi[i] = sHi;
  }
  return { lo, hi, sideLo: xorshift32(sLo), sideHi: xorshift32(sHi) };
}

/** 全局唯一张量（固定种子 => 确定性） */
export const ZOBRIST: ZobristTables = buildZobristTables(SEED_LO, SEED_HI);

/** 取某格某色的低位哈希 */
export function pieceLo(t: ZobristTables, idx: number, color: PlayerColor): number {
  return t.lo[idx * 2 + (color - 1)] ?? 0;
}

/** 取某格某色的高位哈希 */
export function pieceHi(t: ZobristTables, idx: number, color: PlayerColor): number {
  return t.hi[idx * 2 + (color - 1)] ?? 0;
}

/** 计算整盘哈希（会话初始化用一次，之后靠增量异或维护） */
export function hashBoard(t: ZobristTables, b: AiBoard): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (let idx = 0; idx < AI_CELLS; idx += 1) {
    const c = cellAtIdx(b, idx);
    if (c === 0) continue;
    const color: PlayerColor = c === AI_BLACK ? AI_BLACK : 2;
    lo ^= pieceLo(t, idx, color);
    hi ^= pieceHi(t, idx, color);
  }
  return { lo, hi };
}
