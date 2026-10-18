/**
 * 置换表（Transposition Table）。
 *
 * 为什么用 64 位键：单 32 位键在 1<<17 项下碰撞会直接把搜索带偏，
 * 而碰撞的后果是「AI 下到已有子的格子」这类硬错误。lo/hi 同时比对把碰撞率压到 ~2⁻⁶⁴。
 * 即便如此，命中后的 bestMove 仍必须由调用方复核（架构 §9 R1）。
 */

/** 精确值 */
export const FLAG_EXACT = 0;

/** 下界（fail-high，真实值 ≥ score） */
export const FLAG_LOWER = 1;

/** 上界（fail-low，真实值 ≤ score） */
export const FLAG_UPPER = 2;

/** 默认表大小 2^17 项 */
export const DEFAULT_TT_BITS = 17;

/** 复用型条目，避免每个节点分配对象 */
export interface TtEntry {
  /** 分值 */
  score: number;
  /** 该分值对应的搜索深度 */
  depth: number;
  /** 边界类型 */
  flag: number;
  /** 最佳走法（线性索引），-1 表示无 */
  move: number;
}

/** 置换表接口 */
export interface TranspositionTable {
  /** 槽位数量 */
  readonly size: number;
  /** 清空全表（每次 createSearchSession 必调） */
  clear(): void;
  /** 查询；命中时把内容写入 out 并返回 true */
  probe(lo: number, hi: number, out: TtEntry): boolean;
  /** 写入；同槽已有更深条目时保留旧值 */
  store(lo: number, hi: number, score: number, depth: number, flag: number, move: number): void;
}

/**
 * 创建置换表。
 * @param bits 槽位数量的二进制位数，默认 17（测试用小值构造碰撞）
 */
export function createTranspositionTable(bits: number = DEFAULT_TT_BITS): TranspositionTable {
  const safeBits = Math.max(1, Math.min(20, Math.floor(bits)));
  const size = 1 << safeBits;
  const mask = size - 1;
  const keysLo = new Int32Array(size);
  const keysHi = new Int32Array(size);
  const scores = new Int32Array(size);
  const depths = new Int8Array(size);
  const flags = new Int8Array(size);
  const moves = new Int16Array(size);
  const used = new Uint8Array(size);

  const slotOf = (lo: number, hi: number): number => {
    const mixed = ((lo >>> 0) ^ ((hi >>> 0) << 1) ^ ((hi >>> 0) >>> 15)) >>> 0;
    return mixed & mask;
  };

  return {
    size,
    clear(): void {
      used.fill(0);
      keysLo.fill(0);
      keysHi.fill(0);
      scores.fill(0);
      depths.fill(0);
      flags.fill(0);
      moves.fill(0);
    },
    probe(lo: number, hi: number, out: TtEntry): boolean {
      const slot = slotOf(lo, hi);
      if ((used[slot] ?? 0) === 0) return false;
      if ((keysLo[slot] ?? 0) !== lo || (keysHi[slot] ?? 0) !== hi) return false;
      out.score = scores[slot] ?? 0;
      out.depth = depths[slot] ?? 0;
      out.flag = flags[slot] ?? 0;
      out.move = moves[slot] ?? -1;
      return true;
    },
    store(lo: number, hi: number, score: number, depth: number, flag: number, move: number): void {
      const slot = slotOf(lo, hi);
      const occupied = (used[slot] ?? 0) !== 0;
      const sameKey = occupied && (keysLo[slot] ?? 0) === lo && (keysHi[slot] ?? 0) === hi;
      // 深度优先替换：浅层结果覆盖深层结果会明显削弱剪枝效率
      if (occupied && !sameKey && (depths[slot] ?? 0) > depth) return;
      used[slot] = 1;
      keysLo[slot] = lo;
      keysHi[slot] = hi;
      scores[slot] = score;
      depths[slot] = depth;
      flags[slot] = flag;
      moves[slot] = move;
    },
  };
}
