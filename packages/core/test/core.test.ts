/**
 * 五子棋核心逻辑单元测试 (Unit Tests)
 *
 * 【单元测试小白入门小贴士】：
 * 1. 什么是单元测试？
 *    不启动浏览器、不启动服务器，直接用代码去调用函数，检查输出是否符合预期。
 * 2. 核心三件套（Vitest / Jest 语法）：
 *    - describe('名称', () => { ... }) ：测试套件 (Test Suite)，把一组相关的测试归纳在一起。
 *    - it('行为描述', () => { ... })   ：单个测试用例 (Test Case)，测试某一个具体功能或分支。
 *    - expect(实际结果).toBe(预期结果)   ：断言 (Assertion)，判断代码运行结果是否正确。
 * 3. 经典 AAA 测试模式：
 *    - Arrange（准备）：初始化测试数据（如创建棋盘）
 *    - Act（行动）：执行被测函数（如落子 applyMove）
 *    - Assert（断言）：验证结果是否正确（如 expect(r.ok).toBe(true)）
 */

import { describe, it, expect } from 'vitest';
import {
  create,
  currentColor,
  applyMove,
  BLACK,
  WHITE,
  undo,
} from '../src/index';

describe('Gomoku Core Logic (五子棋核心规则测试)', () => {

  // ==========================================
  // 测试用例 1：开局规则
  // ==========================================
  it('黑方先行：开局步数为 0 时，轮次必须为黑棋', () => {
    // 1. Arrange: 创建一个全新的初始棋盘
    const g = create();

    // 2. Assert: 验证当前出手方是不是黑棋 (BLACK = 1)
    expect(currentColor(g)).toBe(BLACK);
  });

  // ==========================================
  // 测试用例 2：落子轮流与位置占用检查
  // ==========================================
  it('轮流落子与占位校验：不可跳过回合，不可下在已有棋子的格子上', () => {
    const g = create();

    // 1. 黑方先行，此时白方试图第一步落子 -> 应该被拒绝
    const rWhiteFirst = applyMove(g, 7, 7, WHITE);
    expect(rWhiteFirst.ok).toBe(false);

    // 2. 黑方在中心天元 (7, 7) 合法落子 -> 应该成功
    const rBlackMove = applyMove(g, 7, 7, BLACK);
    expect(rBlackMove.ok).toBe(true);

    // 3. 白方紧接着也想下在 (7, 7) -> 应该被拒绝，原因为已占用 (occupied)
    const occupied = applyMove(g, 7, 7, WHITE);
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) {
      expect(occupied.reason).toBe('occupied');
    }

    // 4. 刚才白方的非法落子没有生效，当前依然是白方的回合
    expect(currentColor(g)).toBe(WHITE);
  });

  // ==========================================
  // 测试用例 3：边界检查（防御越界输入）
  // ==========================================
  it('越界落子被拒绝：超出 0~14 范围的坐标均判定非法', () => {
    const g = create();

    // 负数坐标越界 (-1, 0)
    const r1 = applyMove(g, -1, 0, BLACK);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('out-of-board');

    // 大于等于 15 越界 (15, 15)
    const r2 = applyMove(g, 15, 15, BLACK);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('out-of-board');
  });

  // ==========================================
  // 测试用例 4：胜负判定 —— 横向（水平方向）五连胜
  // ==========================================
  it('横向五连胜：同一行连续 5 颗同色棋子达成胜利', () => {
    const g = create();

    // 黑子在第 7 行连续下 4 颗：(0,7), (1,7), (2,7), (3,7)
    // 白子在第 8 行下 4 颗应手：(0,8), (1,8), (2,8), (3,8)
    for (let i = 0; i < 4; i++) {
      applyMove(g, i, 7, BLACK);
      applyMove(g, i, 8, WHITE);
    }

    // 黑子落下第 5 颗子 (4, 7) -> 形成横向 5 连！
    const r = applyMove(g, 4, 7, BLACK);

    // 验证返回的胜利事件与连线详情
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event).toBe('win');
      if (r.event === 'win') {
        expect(r.winner).toBe(BLACK);     // 赢家是黑方
        expect(r.line.length).toBe(5);     // 获胜连线刚好包含 5 个坐标
      }
    }

    // 验证棋局全局状态已置为结束
    expect(g.over).toBe(true);
  });

  // ==========================================
  // 测试用例 5：胜负判定 —— 纵向（垂直方向）五连胜
  // ==========================================
  it('竖向五连胜：同一列连续 5 颗同色棋子达成胜利', () => {
    const g = create();

    // 黑在第 5 列下 (5, 0)~(5, 3)；白在第 6 列应对
    for (let i = 0; i < 4; i++) {
      applyMove(g, 5, i, BLACK);
      applyMove(g, 6, i, WHITE);
    }

    // 黑子下第 5 颗 (5, 4) 触发五连胜
    const r = applyMove(g, 5, 4, BLACK);
    expect(r.ok).toBe(true);
    if (r.ok && r.event === 'win') {
      expect(r.winner).toBe(BLACK);
    }
  });

  // ==========================================
  // 测试用例 6：胜负判定 —— 斜向（对角线方向）五连胜
  // ==========================================
  it('斜向五连胜：主对角线连续 5 颗同色棋子达成胜利', () => {
    const g = create();

    // 黑棋走对角线 (0,0), (1,1), (2,2), (3,3)
    for (let i = 0; i < 4; i++) {
      applyMove(g, i, i, BLACK);
      applyMove(g, 14 - i, i, WHITE);
    }

    // 落下第 5 颗子 (4, 4) -> 对角线连成五子
    const r = applyMove(g, 4, 4, BLACK);
    expect(r.ok).toBe(true);
    if (r.ok && r.event === 'win') {
      expect(r.winner).toBe(BLACK);
    }
  });

  // ==========================================
  // 测试用例 7：自由五子棋长连规则（>=5 均判胜）
  // ==========================================
  it('长连（六子）也算胜利：自由五子棋规则允许长连获胜', () => {
    const g = create();

    // 构造巧妙棋局：
    // 黑棋先在第 7 行落下 [0, 1, 2] 与 [4, 5]，故意空出中间的 [3] 号位
    const seq: [number, number, typeof BLACK | typeof WHITE][] = [
      [0, 7, BLACK],
      [10, 0, WHITE],
      [1, 7, BLACK],
      [10, 2, WHITE],
      [2, 7, BLACK],
      [10, 4, WHITE],
      [4, 7, BLACK],
      [10, 6, WHITE],
      [5, 7, BLACK],
      [10, 8, WHITE],
    ];
    for (const [x, y, c] of seq) applyMove(g, x, y, c);

    // 此时尚未形成连续 5 子，游戏未结束
    expect(g.over).toBe(false);

    // 黑棋在空缺的 (3, 7) 落子，瞬间将两段合并为 6 颗连珠！
    const r = applyMove(g, 3, 7, BLACK);
    expect(r.ok).toBe(true);
    if (r.ok && r.event === 'win') {
      expect(r.winner).toBe(BLACK);
      expect(r.line.length).toBe(6); // 连线长度为 6
    }
  });

  // ==========================================
  // 测试用例 8：未达成五连不判胜
  // ==========================================
  it('四子不判胜：连续棋子未达 5 颗时，游戏绝不能提前判定胜利', () => {
    const g = create();
    for (let i = 0; i < 4; i++) applyMove(g, i, 7, BLACK);

    // 即使有 4 连，游戏仍必须继续 (over = false)
    expect(g.over).toBe(false);
  });

  // ==========================================
  // 测试用例 9：游戏结束后禁止继续落子
  // ==========================================
  it('结束后不能再落子：产生胜负后任何落子都必须拒绝', () => {
    const g = create();
    for (let i = 0; i < 4; i++) {
      applyMove(g, i, 7, BLACK);
      applyMove(g, i, 8, WHITE);
    }
    applyMove(g, 4, 7, BLACK); // 第 5 颗黑子落入，黑胜

    // 胜负已定，白棋还想继续下子 -> 必须被拒绝，原因为 game-over
    const r = applyMove(g, 4, 8, WHITE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('game-over');
  });

  // ==========================================
  // 测试用例 10：悔棋（撤销）与状态还原
  // ==========================================
  it('悔棋恢复回合：撤销一步后步数减少、棋盘恢复空位、轮次恢复', () => {
    const g = create();
    applyMove(g, 7, 7, BLACK); // 步数 1
    applyMove(g, 7, 8, WHITE); // 步数 2
    expect(g.moves.length).toBe(2);
    expect(currentColor(g)).toBe(BLACK); // 已下 2 步偶数，当前轮到黑方

    // 执行悔棋：撤销白方刚刚走的 (7, 8)
    const m = undo(g);

    // 验证撤销的那一步数据
    expect(m?.x).toBe(7);
    expect(m?.y).toBe(8);

    // 验证步数倒退为 1 步
    expect(g.moves.length).toBe(1);

    // 验证当前轮次重新变回白方
    expect(currentColor(g)).toBe(WHITE);

    // 验证棋盘上对应的位置重新变为空位 0 (EMPTY)
    expect(g.board[8]?.[7]).toBe(0);
  });
});

