/**
 * 置换表测试：读写一致、键不匹配不命中、碰撞后必须失效、clear 生效。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TT_BITS,
  FLAG_EXACT,
  FLAG_LOWER,
  FLAG_UPPER,
  createTranspositionTable,
  type TtEntry,
} from '../../src/index';

function newEntry(): TtEntry {
  return { score: 0, depth: 0, flag: 0, move: -1 };
}

describe('createTranspositionTable', () => {
  it('默认 2^17 项，且可指定更小的表用于构造碰撞', () => {
    expect(createTranspositionTable().size).toBe(1 << DEFAULT_TT_BITS);
    expect(createTranspositionTable(4).size).toBe(16);
  });

  it('写入后按同一键读回完全一致的内容', () => {
    const tt = createTranspositionTable();
    tt.store(0x1234, 0x5678, 42, 6, FLAG_EXACT, 100);
    const out = newEntry();
    expect(tt.probe(0x1234, 0x5678, out)).toBe(true);
    expect(out.score).toBe(42);
    expect(out.depth).toBe(6);
    expect(out.flag).toBe(FLAG_EXACT);
    expect(out.move).toBe(100);
  });

  it('未写入的键不命中', () => {
    const tt = createTranspositionTable();
    expect(tt.probe(1, 2, newEntry())).toBe(false);
  });

  it('键只有 lo 相同或只有 hi 相同都不命中（64 位比对）', () => {
    const tt = createTranspositionTable();
    tt.store(0x1111, 0x2222, 7, 4, FLAG_LOWER, 3);
    expect(tt.probe(0x1111, 0x3333, newEntry())).toBe(false);
    expect(tt.probe(0x9999, 0x2222, newEntry())).toBe(false);
  });

  it('哈希碰撞：不同键落到同一槽位后旧条目必须失效', () => {
    // bits=4 => 16 个槽位；(0,0) 与 (16,0) 的低 4 位相同，必然同槽
    const tt = createTranspositionTable(4);
    tt.store(0, 0, 111, 4, FLAG_EXACT, 10);
    expect(tt.probe(0, 0, newEntry())).toBe(true);
    tt.store(16, 0, 222, 4, FLAG_EXACT, 20);
    // 旧键不得再命中——否则搜索会拿着别的局面的 bestMove 去落子
    expect(tt.probe(0, 0, newEntry())).toBe(false);
    const out = newEntry();
    expect(tt.probe(16, 0, out)).toBe(true);
    expect(out.move).toBe(20);
  });

  it('clear 后全表失效', () => {
    const tt = createTranspositionTable(4);
    tt.store(5, 6, 1, 2, FLAG_UPPER, 9);
    expect(tt.probe(5, 6, newEntry())).toBe(true);
    tt.clear();
    expect(tt.probe(5, 6, newEntry())).toBe(false);
  });

  it('深度优先替换：浅层条目不会覆盖同槽的深层条目', () => {
    const tt = createTranspositionTable(4);
    tt.store(0, 0, 100, 8, FLAG_EXACT, 1);
    tt.store(16, 0, 200, 2, FLAG_EXACT, 2);
    const out = newEntry();
    expect(tt.probe(0, 0, out)).toBe(true);
    expect(out.score).toBe(100);
  });

  it('同键再次写入会更新（同深度覆盖）', () => {
    const tt = createTranspositionTable(4);
    tt.store(3, 4, 10, 4, FLAG_UPPER, 1);
    tt.store(3, 4, 20, 4, FLAG_EXACT, 2);
    const out = newEntry();
    expect(tt.probe(3, 4, out)).toBe(true);
    expect(out.score).toBe(20);
    expect(out.move).toBe(2);
  });
});
