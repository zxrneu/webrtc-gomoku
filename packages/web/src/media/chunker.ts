/**
 * 分片计划（纯函数）：只算区间，不触碰 Blob，便于毫秒级单测。
 */
export interface ChunkRange {
  /** 0 基序号 */
  seq: number;
  /** 起始字节（含） */
  start: number;
  /** 结束字节（不含） */
  end: number;
}

/**
 * 计算分片区间；空文件返回 1 个空分片（保证接收端仍能走完 meta→end 流程）。
 *
 * @param size 文件字节数（≥0）
 * @param chunkSize 分片大小（>0）
 */
export function chunkRanges(size: number, chunkSize: number): ChunkRange[] {
  if (!Number.isFinite(size) || size < 0) throw new Error('文件大小非法');
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error('分片大小非法');
  const ranges: ChunkRange[] = [];
  if (size === 0) {
    return [{ seq: 0, start: 0, end: 0 }];
  }
  for (let start = 0, seq = 0; start < size; start += chunkSize, seq += 1) {
    ranges.push({ seq, start, end: Math.min(size, start + chunkSize) });
  }
  return ranges;
}
