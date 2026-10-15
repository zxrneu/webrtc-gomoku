/*
 * 五子棋纯逻辑（无 DOM 依赖）
 * 浏览器中挂载为 window.GameCore；Node 中通过 module.exports 导出，便于单元测试。
 * 规则：自由五子棋（无禁手），黑方先行，横/竖/斜任一方向先连成 5 子（含长连）即胜。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GameCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 15;
  const BLACK = 1;
  const WHITE = 2;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function create() {
    return {
      size: SIZE,
      board: Array.from({ length: SIZE }, () => new Array(SIZE).fill(0)),
      moves: [],
      over: false,
      winLine: null,
    };
  }

  function inBounds(g, x, y) {
    return x >= 0 && y >= 0 && x < g.size && y < g.size;
  }

  // 黑方先行：已落子数为偶数时轮到黑方
  function currentColor(g) {
    return g.moves.length % 2 === 0 ? BLACK : WHITE;
  }

  function otherColor(c) {
    return c === BLACK ? WHITE : BLACK;
  }

  // 返回 (x,y) 处 color 一方的完整连线（>=5 才返回），否则 null
  function winLineAt(g, x, y, color) {
    for (const [dx, dy] of DIRS) {
      const line = [[x, y]];
      for (const step of [1, -1]) {
        let nx = x + dx * step;
        let ny = y + dy * step;
        while (inBounds(g, nx, ny) && g.board[ny][nx] === color) {
          if (step === 1) line.push([nx, ny]);
          else line.unshift([nx, ny]);
          nx += dx * step;
          ny += dy * step;
        }
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  /**
   * 落子。返回 { ok, event, winner?, line?, reason? }
   * event: 'move' | 'win' | 'draw'
   */
  function applyMove(g, x, y, color) {
    if (g.over) return { ok: false, reason: 'game-over' };
    if (!inBounds(g, x, y)) return { ok: false, reason: 'out-of-board' };
    if (g.board[y][x] !== 0) return { ok: false, reason: 'occupied' };
    if (color !== currentColor(g)) return { ok: false, reason: 'not-your-turn' };
    g.board[y][x] = color;
    g.moves.push({ x, y, c: color });
    const line = winLineAt(g, x, y, color);
    if (line) {
      g.over = true;
      g.winLine = line;
      return { ok: true, event: 'win', winner: color, line };
    }
    if (g.moves.length === SIZE * SIZE) {
      g.over = true;
      return { ok: true, event: 'draw' };
    }
    return { ok: true, event: 'move' };
  }

  function undo(g) {
    const m = g.moves.pop();
    if (!m) return null;
    g.board[m.y][m.x] = 0;
    g.over = false;
    g.winLine = null;
    return m;
  }

  return { SIZE, BLACK, WHITE, DIRS, create, inBounds, currentColor, otherColor, winLineAt, applyMove, undo };
});
