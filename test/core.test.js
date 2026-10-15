'use strict';
/* 五子棋核心逻辑单元测试：node test/core.test.js */
const assert = require('node:assert');
const Core = require('../public/game-core.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    failed++;
    console.error('  FAIL -', name);
    console.error('   ', e.message);
    process.exitCode = 1;
  }
}

test('黑方先行', () => {
  const g = Core.create();
  assert.strictEqual(Core.currentColor(g), Core.BLACK);
});

test('轮流落子与占位校验', () => {
  const g = Core.create();
  assert.strictEqual(Core.applyMove(g, 7, 7, Core.WHITE).ok, false); // 白方不能先走
  assert.strictEqual(Core.applyMove(g, 7, 7, Core.BLACK).ok, true);
  assert.strictEqual(Core.applyMove(g, 7, 7, Core.WHITE).reason, 'occupied');
  assert.strictEqual(Core.currentColor(g), Core.WHITE);
});

test('越界落子被拒绝', () => {
  const g = Core.create();
  assert.strictEqual(Core.applyMove(g, -1, 0, Core.BLACK).reason, 'out-of-board');
  assert.strictEqual(Core.applyMove(g, 15, 15, Core.BLACK).reason, 'out-of-board');
});

test('横向五连胜', () => {
  const g = Core.create();
  for (let i = 0; i < 4; i++) {
    Core.applyMove(g, i, 7, Core.BLACK);
    Core.applyMove(g, i, 8, Core.WHITE);
  }
  const r = Core.applyMove(g, 4, 7, Core.BLACK);
  assert.strictEqual(r.event, 'win');
  assert.strictEqual(r.winner, Core.BLACK);
  assert.strictEqual(g.over, true);
  assert.strictEqual(r.line.length, 5);
});

test('竖向五连胜', () => {
  const g = Core.create();
  for (let i = 0; i < 4; i++) {
    Core.applyMove(g, 5, i, Core.BLACK);
    Core.applyMove(g, 6, i, Core.WHITE);
  }
  const r = Core.applyMove(g, 5, 4, Core.BLACK);
  assert.strictEqual(r.event, 'win');
});

test('斜向五连胜', () => {
  const g = Core.create();
  for (let i = 0; i < 4; i++) {
    Core.applyMove(g, i, i, Core.BLACK);
    Core.applyMove(g, 14 - i, i, Core.WHITE);
  }
  const r = Core.applyMove(g, 4, 4, Core.BLACK);
  assert.strictEqual(r.event, 'win');
});

test('长连（六子）也算胜利', () => {
  const g = Core.create();
  // 黑方先在 7 行落下 (0,1,2) 和 (4,5)，中间留空，落 (3,7) 时形成六连
  const seq = [
    [0, 7, Core.BLACK], [10, 0, Core.WHITE],
    [1, 7, Core.BLACK], [10, 2, Core.WHITE],
    [2, 7, Core.BLACK], [10, 4, Core.WHITE],
    [4, 7, Core.BLACK], [10, 6, Core.WHITE],
    [5, 7, Core.BLACK], [10, 8, Core.WHITE],
  ];
  for (const [x, y, c] of seq) Core.applyMove(g, x, y, c);
  assert.strictEqual(g.over, false); // 此时最多 3 连，未分胜负
  const r = Core.applyMove(g, 3, 7, Core.BLACK);
  assert.strictEqual(r.event, 'win');
  assert.strictEqual(r.line.length, 6);
});

test('四子不判胜', () => {
  const g = Core.create();
  for (let i = 0; i < 4; i++) Core.applyMove(g, i, 7, Core.BLACK);
  assert.strictEqual(g.over, false);
});

test('结束后不能再落子', () => {
  const g = Core.create();
  for (let i = 0; i < 4; i++) {
    Core.applyMove(g, i, 7, Core.BLACK);
    Core.applyMove(g, i, 8, Core.WHITE);
  }
  Core.applyMove(g, 4, 7, Core.BLACK);
  assert.strictEqual(Core.applyMove(g, 10, 10, Core.WHITE).reason, 'game-over');
});

test('悔棋恢复回合', () => {
  const g = Core.create();
  Core.applyMove(g, 7, 7, Core.BLACK);
  Core.applyMove(g, 8, 8, Core.WHITE);
  const m = Core.undo(g);
  assert.deepStrictEqual(m, { x: 8, y: 8, c: Core.WHITE });
  assert.strictEqual(g.board[8][8], 0);
  assert.strictEqual(Core.currentColor(g), Core.WHITE); // 悔掉白方一手，又轮到白方
});

test('棋盘下满判平局', () => {
  const g = Core.create();
  // 构造一个无五连的快满棋盘：颜色 = ((x + 2y) % 4 < 2) ? 黑 : 白
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      g.board[y][x] = (x + 2 * y) % 4 < 2 ? Core.BLACK : Core.WHITE;
    }
  }
  g.board[14][14] = 0; // 留最后一格
  g.moves = new Array(224).fill({ x: 0, y: 0, c: Core.BLACK }); // 224 手，下一手轮到黑方
  const r = Core.applyMove(g, 14, 14, Core.BLACK);
  assert.strictEqual(r.event, 'draw');
  assert.strictEqual(g.over, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
