import { describe, expect, it } from 'vitest';

import { chunkRanges } from '../../src/media/chunker';

describe('chunkRanges', () => {
  it('空文件给出 1 个空分片', () => {
    expect(chunkRanges(0, 1024)).toEqual([{ seq: 0, start: 0, end: 0 }]);
  });

  it('整除时无多余分片', () => {
    expect(chunkRanges(2048, 1024)).toEqual([
      { seq: 0, start: 0, end: 1024 },
      { seq: 1, start: 1024, end: 2048 },
    ]);
  });

  it('余数分片截断到文件尾', () => {
    expect(chunkRanges(2500, 1024)).toEqual([
      { seq: 0, start: 0, end: 1024 },
      { seq: 1, start: 1024, end: 2048 },
      { seq: 2, start: 2048, end: 2500 },
    ]);
  });

  it('非法参数抛错', () => {
    expect(() => chunkRanges(-1, 10)).toThrow();
    expect(() => chunkRanges(10, 0)).toThrow();
  });
});
