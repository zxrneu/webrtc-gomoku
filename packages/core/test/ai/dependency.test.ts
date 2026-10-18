import { describe, expect, it } from 'vitest';
import { analyzeThreats, orderAttackCandidates, threatDependsOn, type Threat } from '../../src/ai/dependency';
import { BLACK, WHITE, fromGameState, idxOf, xOf, yOf, AI_SIZE } from '../../src/index';
import { buildAlternating } from './helpers';

const cell = (x: number) => idxOf(x, 7);

describe('威胁的进攻、应对与依赖空点', () => {
  it('直活三保留两侧应对点及继续成形需要的空点', () => {
    const board = fromGameState(buildAlternating([[5, 7], [6, 7]], [[0, 0], [0, 2]]));
    const threats = analyzeThreats(board, cell(7), BLACK);
    expect(threats.some((t) => t.kind === 'three' && t.gain === cell(7) &&
      t.cost.includes(cell(4)) && t.cost.includes(cell(8)) && t.rest.includes(cell(8)))).toBe(true);
  });

  it('活四保留两个成五点', () => {
    const board = fromGameState(buildAlternating([[4, 7], [5, 7], [6, 7]], [[0, 0], [0, 2], [0, 4]]));
    expect(analyzeThreats(board, cell(7), BLACK)).toContainEqual(expect.objectContaining({
      kind: 'four', cost: [cell(3), cell(8)],
    }));
  });

  it('跳四记录内部唯一应对点', () => {
    const board = fromGameState(buildAlternating([[4, 7], [6, 7], [8, 7]], [[0, 0], [0, 2], [0, 4]]));
    expect(analyzeThreats(board, cell(7), BLACK)).toContainEqual(expect.objectContaining({ kind: 'four', cost: [cell(5)] }));
  });

  it('四三复合威胁同时保留两个方向', () => {
    const board = fromGameState(buildAlternating([[4, 7], [5, 7], [6, 7], [7, 5], [7, 6]],
      [[0, 0], [0, 2], [0, 4], [0, 6], [14, 14]]));
    const kinds = analyzeThreats(board, cell(7), BLACK).map((t) => t.kind);
    expect(kinds).toContain('four');
    expect(kinds).toContain('three');
  });

  it('后续威胁依赖前一步落子，冲突的应对点不能作为已有棋子', () => {
    const parent: Threat = { kind: 'three', gain: cell(7), cost: [cell(4), cell(8)],
      rest: [cell(3), cell(4), cell(8)], stones: [cell(5), cell(6)] };
    const child: Threat = { kind: 'four', gain: cell(8), cost: [cell(4), cell(9)],
      rest: [cell(4), cell(9)], stones: [cell(5), cell(6), cell(7)] };
    expect(threatDependsOn(parent, child)).toBe(true);
    expect(threatDependsOn(parent, { ...child, stones: [...child.stones, cell(4)] })).toBe(false);
    expect(threatDependsOn(parent, { ...child, gain: cell(10) })).toBe(false);
  });

  it.each([[1, 0], [0, 1], [1, 1], [1, -1]])('四方向及白棋也识别成五 %j', (dx, dy) => {
    const board = new Int8Array(225);
    for (let n = 1; n <= 4; n += 1) board[idxOf(7 + n * dx, 7 + n * dy)] = WHITE;
    expect(analyzeThreats(board, cell(7), WHITE).some((t) => t.kind === 'five')).toBe(true);
  });

  it('分析不修改输入，已占用、越界及坏棋盘返回空列表', () => {
    const board = new Int8Array(225);
    board[cell(5)] = BLACK;
    const before = board.slice();
    analyzeThreats(board, cell(7), BLACK);
    expect(board).toEqual(before);
    expect(analyzeThreats(board, cell(5), BLACK)).toEqual([]);
    expect(analyzeThreats(board, -1, BLACK)).toEqual([]);
    expect(analyzeThreats(new Int8Array(0), 0, BLACK)).toEqual([]);
  });

  it('旋转与镜像局面下威胁检测保持一致', () => {
    // 原始局面：横向活三
    const original = fromGameState(buildAlternating([[5, 7], [6, 7]], [[0, 0], [0, 2]]));
    const origThreats = analyzeThreats(original, cell(7), BLACK);
    expect(origThreats.some((t) => t.kind === 'three')).toBe(true);

    // 旋转 90 度：横向变纵向
    const rotated = new Int8Array(225);
    for (let i = 0; i < 225; i += 1) {
      if (original[i] === 0) continue;
      const x = xOf(i);
      const y = yOf(i);
      rotated[idxOf(14 - y, x)] = original[i]!;
    }
    const rotAt = idxOf(14 - 7, 7);
    const rotThreats = analyzeThreats(rotated, rotAt, BLACK);
    expect(rotThreats.some((t) => t.kind === 'three')).toBe(true);

    // 镜像局面：左右镜像
    const mirrored = new Int8Array(225);
    for (let i = 0; i < 225; i += 1) {
      if (original[i] === 0) continue;
      const x = xOf(i);
      const y = yOf(i);
      mirrored[idxOf(14 - x, y)] = original[i]!;
    }
    const mirAt = idxOf(14 - 7, 7);
    const mirThreats = analyzeThreats(mirrored, mirAt, BLACK);
    expect(mirThreats.some((t) => t.kind === 'three')).toBe(true);
  });

  it('orderAttackCandidates: 复合威胁排在单冲四和单活三前面', () => {
    // [4, 7], [5, 7], [6, 7] 并在 [7, 5], [7, 6] 有子：cell(7) 构成四三
    // 另一处 [0, 0], [1, 0], [2, 0]：[3, 0] 构成冲四
    const board = fromGameState(buildAlternating(
      [[4, 7], [5, 7], [6, 7], [7, 5], [7, 6], [0, 0], [1, 0], [2, 0]],
      [[14, 14], [14, 12], [14, 10], [14, 8], [14, 6], [14, 4], [14, 2], [14, 0]],
    ));
    const moves = orderAttackCandidates(board, BLACK, 'threats');
    expect(moves[0]).toBe(cell(7)); // 四三复合威胁优先排在最前
  });

  it('orderAttackCandidates: 依赖前序威胁的后续活三优先排列', () => {
    const board = fromGameState(buildAlternating(
      [[5, 7], [6, 7], [7, 7], [8, 6]],
      [[0, 0], [0, 2], [0, 4], [0, 6]],
    ));
    const parentThreat: Threat = {
      kind: 'three',
      gain: cell(7),
      cost: [cell(8)],
      rest: [cell(8)],
      stones: [cell(5), cell(6)],
    };
    const moves = orderAttackCandidates(board, BLACK, 'threats', parentThreat);
    expect(moves.indexOf(cell(8))).toBeLessThan(moves.indexOf(cell(4)));
  });

  it('orderAttackCandidates: 对手有立即成五点时强制堵防，双五威胁返回空', () => {
    // 对手有 4 连 [4, 9], [5, 9], [6, 9], [7, 9]，两头 3, 9 与 8, 9 均可成五
    const doubleThreatBoard = fromGameState(buildAlternating(
      [[0, 0], [0, 2], [0, 4], [0, 6]],
      [[4, 9], [5, 9], [6, 9], [7, 9]],
    ));
    expect(orderAttackCandidates(doubleThreatBoard, BLACK, 'threats')).toEqual([]);

    // 对手仅单点成五（一头被堵）
    const singleThreatBoard = fromGameState(buildAlternating(
      [[0, 0], [0, 2], [0, 4], [0, 6]],
      [[4, 9], [5, 9], [6, 9], [7, 9]],
    ));
    singleThreatBoard[idxOf(3, 9)] = BLACK; // 堵住一头
    const candidates = orderAttackCandidates(singleThreatBoard, BLACK, 'threats');
    expect(candidates).toEqual([idxOf(8, 9)]); // 唯一必须堵的点
  });
});
