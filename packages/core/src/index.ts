/**
 * 五子棋纯逻辑（无 DOM 依赖）
 * 规则：自由五子棋（无禁手），黑方先行，横/竖/斜任一方向先连成 5 子（含长连）即胜。
 */

// ==========================================
// 1. 基础常量定义
// ==========================================

/** 棋盘标准尺寸：15 × 15 路 */
export const SIZE = 15;

/** 0 代表该交叉点为空（无棋子） */
export const EMPTY = 0 as const;

/** 1 代表黑棋（黑方先行） */
export const BLACK = 1 as const;

/** 2 代表白棋 */
export const WHITE = 2 as const;

// ==========================================
// 2. 类型定义 (TypeScript Types)
// ==========================================

/** 空位类型（固定为 0） */
export type EmptyColor = typeof EMPTY;

/** 玩家棋子颜色：黑棋(1) 或 白棋(2) */
export type PlayerColor = typeof BLACK | typeof WHITE;

/** 交叉点状态：可以是空(0)、黑(1) 或 白(2) */
export type Color = EmptyColor | PlayerColor;

/** 坐标点：元组格式 [x, y]，x 为横坐标(列)，y 为纵坐标(行) */
export type Point = [number, number];

/**
 * 单步落子数据结构
 */
export interface Move {
  /** 横坐标（从左到右 0 ~ 14） */
  x: number;
  /** 纵坐标（从上到下 0 ~ 14） */
  y: number;
  /** 执子方颜色：BLACK(1) 或 WHITE(2) */
  c: PlayerColor;
}

/**
 * 完整棋局状态快照
 */
export interface GameState {
  /** 棋盘尺寸（通常为 15） */
  size: number;
  /** 15x15 的二维数组，表示当前棋盘所有格子的状态：board[y][x] */
  board: Color[][];
  /** 按时间顺序排列的所有历史落子记录 */
  moves: Move[];
  /** 游戏是否已结束（分出胜负或平局后为 true） */
  over: boolean;
  /** 获胜时的五子连线坐标列表（如果未产生胜负则为 null） */
  winLine: Point[] | null;
}

/**
 * 落子操作的返回值（判别联合类型 Discriminated Union）
 * 外部调用方可以通过判断 result.ok 来区分成功还是失败
 */
export type MoveResult =
  | { ok: true; event: 'move' }                                                // 落子成功，游戏继续
  | { ok: true; event: 'win'; winner: PlayerColor; line: Point[] }             // 落子成功且达成五连胜
  | { ok: true; event: 'draw' }                                                // 落子成功且棋盘填满，判定和棋
  | { ok: false; reason: 'game-over' | 'out-of-board' | 'occupied' | 'not-your-turn' }; // 落子被拒绝及原因

// ==========================================
// 3. 辅助常量与初始化函数
// ==========================================

/**
 * 4 个探测方向的单位向量 [dx, dy]：
 * 1. [1, 0]   水平向右
 * 2. [0, 1]   垂直向下
 * 3. [1, 1]   对角线向右下（从左上到右下）
 * 4. [1, -1]  对角线向右上（从左下到右上）
 * 配合反向倍率 step = -1，即可覆盖完整的米字型 8 个方向
 */
export const DIRS: readonly [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

/**
 * 创建并初始化一个全新状态的五子棋游戏
 * @returns 包含初始 15x15 空棋盘的 GameState 对象
 */
export function create(): GameState {
  return {
    size: SIZE,
    // 创建 15 行，每行包含 15 个 EMPTY(0) 的二维数组
    board: Array.from({ length: SIZE }, () => new Array<Color>(SIZE).fill(EMPTY)),
    moves: [],
    over: false,
    winLine: null,
  };
}

/**
 * 边界检查：判断 (x, y) 坐标是否落在棋盘内
 * @param g 游戏状态
 * @param x 横坐标
 * @param y 纵坐标
 * @returns true 表示在棋盘内，false 表示越界
 */
export function inBounds(g: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < g.size && y < g.size;
}

// ==========================================
// 4. 轮次与玩家转换
// ==========================================

/**
 * 计算当前轮到哪一方落子
 * 规则：黑方先行，因此已落子总数为偶数时轮到黑方(1)，奇数时轮到白方(2)
 * @param g 游戏状态
 * @returns 当前该出手的玩家颜色 (BLACK 或 WHITE)
 */
export function currentColor(g: GameState): PlayerColor {
  return g.moves.length % 2 === 0 ? BLACK : WHITE;
}

/**
 * 获取对手的棋子颜色
 * @param c 当前玩家颜色
 * @returns 对手的颜色（黑变白，白变黑）
 */
export function otherColor(c: PlayerColor): PlayerColor {
  return c === BLACK ? WHITE : BLACK;
}

// ==========================================
// 5. 核心算法：五连胜连线检测
// ==========================================

/**
 * 检查在 (x, y) 处落子后，是否在该点形成 >= 5 的连续同色棋子
 * 算法原理：双向射线扫描法（向正方向延伸 + 向反方向延伸）
 *
 * @param g 游戏状态
 * @param x 刚落子的横坐标
 * @param y 刚落子的纵坐标
 * @param color 刚落子的棋子颜色
 * @returns 若达成五连胜，返回连线上所有棋子的坐标数组（按顺序排列）；若未达成则返回 null
 */
export function winLineAt(g: GameState, x: number, y: number, color: PlayerColor): Point[] | null {
  // 分别检查 4 条轴线：横向、纵向、主对角线、副对角线
  for (const [dx, dy] of DIRS) {
    // 初始连线包含刚下的这个中心点
    const line: Point[] = [[x, y]];

    // step = 1 表示沿向量向前走；step = -1 表示沿向量向后走
    for (const step of [1, -1] as const) {
      let nx = x + dx * step;
      let ny = y + dy * step;

      // 只要坐标在棋盘内，且格子里的棋子颜色与当前落子相同，就继续往前数
      while (inBounds(g, nx, ny) && g.board[ny]?.[nx] === color) {
        if (step === 1) {
          // 正方向探索到的点追加到数组末尾
          line.push([nx, ny]);
        } else {
          // 反方向探索到的点插入到数组头部，保证整条线上的点连续有序
          line.unshift([nx, ny]);
        }
        nx += dx * step;
        ny += dy * step;
      }
    }

    // 自由五子棋规则：连续同色棋子达到或超过 5 颗（含长连）即算胜
    if (line.length >= 5) return line;
  }
  return null;
}

// ==========================================
// 6. 落子控制器与悔棋实现
// ==========================================

/**
 * 执行落子逻辑（整个棋局的核心操作）
 * 包含：前置合法性检查、更新棋盘状态、记录落子历史、判定胜负与平局
 *
 * @param g 游戏状态（会被原地修改）
 * @param x 想要落子的横坐标 (0 ~ 14)
 * @param y 想要落子的纵坐标 (0 ~ 14)
 * @param color 想要落子的玩家颜色 (BLACK 或 WHITE)
 * @returns MoveResult 结果对象，包含成功或失败的具体信息
 */
export function applyMove(g: GameState, x: number, y: number, color: PlayerColor): MoveResult {
  // 1. 守卫条件检查：游戏是否已经结束
  if (g.over) return { ok: false, reason: 'game-over' };

  // 2. 守卫条件检查：落子坐标是否越界
  if (!inBounds(g, x, y)) return { ok: false, reason: 'out-of-board' };

  // 3. 守卫条件检查：目标格子是否已被其他棋子占据
  const row = g.board[y];
  if (!row || row[x] !== EMPTY) return { ok: false, reason: 'occupied' };

  // 4. 守卫条件检查：是否轮到该方出手（防止玩家连续落子或对手代下）
  if (color !== currentColor(g)) return { ok: false, reason: 'not-your-turn' };

  // --- 通过所有检查，正式执行落子 ---
  row[x] = color;                   // 1. 在二维棋盘上放置棋子
  g.moves.push({ x, y, c: color }); // 2. 记录入历史栈

  // 5. 胜负检测：检查刚落下的这颗子是否形成了五连胜
  const line = winLineAt(g, x, y, color);
  if (line) {
    g.over = true;
    g.winLine = line;
    return { ok: true, event: 'win', winner: color, line };
  }

  // 6. 平局检测：如果步数已达棋盘总格子数 (15 × 15 = 225)，说明棋盘已满且无人获胜
  if (g.moves.length === g.size * g.size) {
    g.over = true;
    return { ok: true, event: 'draw' };
  }

  // 7. 正常落子，对局继续
  return { ok: true, event: 'move' };
}

/**
 * 悔棋操作：撤销上一步落子
 *
 * @param g 游戏状态（会被原地修改）
 * @returns 被撤销的那一步 Move 记录；若无棋可悔（刚开局）则返回 null
 */
export function undo(g: GameState): Move | null {
  // 从历史记录弹出最后一步
  const m = g.moves.pop();
  if (!m) return null;

  // 将棋盘上对应的格子恢复为空位 EMPTY(0)
  const row = g.board[m.y];
  if (row) row[m.x] = EMPTY;

  // 恢复游戏未结束状态，并清空获胜连线
  g.over = false;
  g.winLine = null;

  return m;
}
