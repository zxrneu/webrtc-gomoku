import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { Color, Move, PlayerColor, Point } from '@webrtc-gomoku/core';
import { SIZE, BLACK, WHITE, inBounds } from '@webrtc-gomoku/core';
import styles from './Board.module.css';

/**
 * 棋盘组件入参接口（遵循单一职责与接口隔离原则）
 * 接收纯展示状态与用户交互回调，组件内部不维护 WebRTC 连接，只负责绘制与事件分发
 */
interface BoardProps {
  /** 15x15 的二维棋盘网格矩阵（0: 空, 1: 黑, 2: 白） */
  board: Color[][];
  /** 历史落子记录列表，用于绘制最后一手高亮标记及计步 */
  moves: Move[];
  /** 获胜五子连线坐标集（若有胜负则为 5 个点的坐标数组，未分胜负为 null） */
  winLine: Point[] | null;
  /** P2P 房间当前是否已成功建立对等连接 */
  connected: boolean;
  /** 当前回合文本提示（如 "轮到你下棋（黑棋）" / "等待对方下棋..."） */
  turnText: string;
  /** 遮罩层提示文本（如 "等待对手加入房间..."） */
  overlayText: string;
  /** 是否展示遮罩层（连接未建立或等待时为 true） */
  showOverlay: boolean;
  /** 游戏是否已结束 */
  over: boolean;
  /** 对局结果描述文本（如 "你赢了！🎉" / "对方获胜" / "和棋"） */
  resultText: string;
  /** 全局音效开关状态 */
  soundEnabled: boolean;
  /** 当前是否属于本端玩家的回合（用于限制非自己回合禁止落子及虚影预览） */
  myTurn: boolean;
  /** 本端玩家分配到的棋子颜色（BLACK 或 WHITE） */
  myColor: PlayerColor;
  /** 当前是否允许申请悔棋 */
  canUndo: boolean;
  /** 用户点击棋盘网格落子回调 (x: 0~14, y: 0~14) */
  onMove: (x: number, y: number) => void;
  /** 点击悔棋按钮回调 */
  onUndo: () => void;
  /** 点击重新开始按钮回调 */
  onRestart: () => void;
  /** 点击音效切换按钮回调 */
  onToggleSound: () => void;
  /** 对局结束后点击再来一局回调 */
  onRematch: () => void;
}

/**
 * ============================================================================
 * 棋盘数学常量体系（Canvas 2D 栅格坐标系统）
 * ============================================================================
 * 五子棋盘共有 15 条水平线和 15 条垂直线，产生 15x15 = 225 个交叉点。
 * 
 * 为什么用 HTML5 Canvas 而不是 225 个 DOM <div>？
 * 1. 极致性能：225 个带圆角、径向渐变阴影的 DOM 节点在鼠标移动时会触发浏览器频繁的重排(Reflow)与重绘(Repaint)；
 *    而 Canvas 是单层光栅位图，利用 GPU 2D 硬件加速，在 60FPS 下平滑绘制悬停虚影与光晕。
 * 2. 细腻质感：Canvas 支持原生径向渐变 (RadialGradient)、像素级阴影 (ShadowBlur) 与微小木纹线条。
 * 
 * 坐标系换算公式：
 * - 任意交叉点 (x, y) 对应的物理像素中心点为：
 *   px = PAD + x * CELL;
 *   py = PAD + y * CELL;
 */
/** 每个网格间距（像素） */
const CELL = 36;
/** 棋盘边缘外留白边距（像素），留出空间给 A-O、1-15 坐标刻度显示 */
const PAD = 28;
/** Canvas 渲染视口的物理分辨率宽度与高度（560 x 560 像素） */
const CANVAS_SIZE = (SIZE - 1) * CELL + PAD * 2; // (15 - 1) * 36 + 28 * 2 = 560
/** 棋盘水平横轴坐标标记字母表（A 到 O，共 15 列） */
const COLS = 'ABCDEFGHIJKLMNO';

/**
 * 棋盘核心组件 (Board)
 * 采用 Canvas 2D 绘制拟真木纹质感、棋子立体光影、最后一手指示标、胜利连线光芒以及鼠标磁吸悬停虚影
 */
export const Board: React.FC<BoardProps> = ({
  board,
  moves,
  winLine,
  connected,
  turnText,
  overlayText,
  showOverlay,
  over,
  resultText,
  soundEnabled,
  myTurn,
  myColor,
  canUndo,
  onMove,
  onUndo,
  onRestart,
  onToggleSound,
  onRematch,
}) => {
  /** Canvas DOM 节点的引用，用于获取 2D 渲染上下文 (CanvasRenderingContext2D) */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 鼠标在棋盘上悬停时，磁吸计算出的最近交叉点坐标 {x, y}；离开棋盘或越界时为 null */
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  /**
   * 核心重绘函数：由 useEffect 在状态变动时触发全量光栅化重绘
   */
  const drawBoard = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 1. 清空画板并绘制高档榧木/榉木纹理的拟真径向渐变背景
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 采用居中向外扩散的径向渐变，模拟中间亮堂、边缘微暗的真实聚光灯木盘质感
    const grad = ctx.createRadialGradient(
      CANVAS_SIZE / 2,
      CANVAS_SIZE / 2,
      20,
      CANVAS_SIZE / 2,
      CANVAS_SIZE / 2,
      CANVAS_SIZE * 0.7
    );
    grad.addColorStop(0, '#e8c47b'); // 内部亮木金黄色
    grad.addColorStop(1, '#d5aa53'); // 外部微暗暖木色
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 2. 绘制棋盘表面细腻的微木纹（间距 6px 的浅褐色细线）
    ctx.strokeStyle = 'rgba(110, 80, 30, 0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i < CANVAS_SIZE; i += 6) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(CANVAS_SIZE, i);
      ctx.stroke();
    }

    // 3. 绘制外围坐标标尺：水平方向 A-O，垂直方向 15-1（符合传统棋谱阅读习惯）
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = '#7a5924';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < SIZE; i++) {
      const p = PAD + i * CELL;
      const col = COLS[i] || '';
      const row = String(15 - i);
      // 上下边刻度 (A-O)
      ctx.fillText(col, p, 12);
      ctx.fillText(col, p, CANVAS_SIZE - 12);
      // 左右边刻度 (15-1)
      ctx.fillText(row, 12, p);
      ctx.fillText(row, CANVAS_SIZE - 12, p);
    }

    // 4. 绘制 15x15 网格线
    ctx.strokeStyle = '#704f1a';
    ctx.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      const p = PAD + i * CELL;
      // 水平横线 (from x=PAD to x=CANVAS_SIZE-PAD)
      ctx.beginPath();
      ctx.moveTo(PAD, p);
      ctx.lineTo(CANVAS_SIZE - PAD, p);
      ctx.stroke();
      // 垂直竖线 (from y=PAD to y=CANVAS_SIZE-PAD)
      ctx.beginPath();
      ctx.moveTo(p, PAD);
      ctx.lineTo(p, CANVAS_SIZE - PAD);
      ctx.stroke();
    }

    // 5. 棋盘外框边线加粗（视觉增强边界立体感）
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, PAD, (SIZE - 1) * CELL, (SIZE - 1) * CELL);

    // 6. 绘制标准五子棋星位（天元及四角星位，共 5 个定位圆点）
    // 坐标分别为 (3,3), (11,3), (7,7)(天元), (3,11), (11,11)
    const stars: [number, number][] = [
      [3, 3],
      [11, 3],
      [7, 7],
      [3, 11],
      [11, 11],
    ];
    ctx.fillStyle = '#704f1a';
    for (const [sx, sy] of stars) {
      ctx.beginPath();
      ctx.arc(PAD + sx * CELL, PAD + sy * CELL, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 7. 遍历全盘矩阵，绘制所有已落下的棋子
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = board[y]?.[x];
        if (c === BLACK || c === WHITE) {
          drawStone(ctx, x, y, c);
        }
      }
    }

    // 8. 绘制鼠标悬停磁吸预览虚影（半透明幽灵棋子）
    // 触发条件：当前处于自己的回合、已连线、游戏未结束、且该交叉点尚未落子
    if (hoverPos && connected && !over && myTurn) {
      const { x, y } = hoverPos;
      if (board[y]?.[x] === 0) {
        drawGhostStone(ctx, x, y, myColor);
      }
    }

    // 9. 最后一手落子醒目标记（在最新一枚棋子中心绘制小红点，便于对局者追踪战况）
    if (moves.length > 0) {
      const last = moves[moves.length - 1]!;
      const lx = PAD + last.x * CELL;
      const ly = PAD + last.y * CELL;
      ctx.beginPath();
      ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = last.c === BLACK ? '#f87171' : '#dc2626';
      ctx.fill();
    }

    // 10. 获胜五子金色辉光连线（游戏决出胜负时高亮标出制胜五子）
    if (winLine && winLine.length >= 5) {
      drawWinLine(ctx, winLine);
    }
  }, [board, moves, winLine, hoverPos, connected, over, myTurn, myColor]);

  /**
   * 绘制单枚立体棋子（黑子/白子）
   * 技巧：通过微小偏移绘制柔和投影，搭配偏心径向高光渐变，营造真实云子微凸的鹅卵石触感
   */
  function drawStone(ctx: CanvasRenderingContext2D, x: number, y: number, color: PlayerColor) {
    const cx = PAD + x * CELL;
    const cy = PAD + y * CELL;
    const r = CELL * 0.44; // 棋子半径约为网格的一半微小收缩（防止棋子贴紧产生拥挤）

    // 1. 棋子右下方柔和投影 (Drop Shadow)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx + 1.5, cy + 2.5, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.fill();
    ctx.restore();

    // 2. 棋子本体与 3D 偏心高光材质
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (color === BLACK) {
      // 黑子：左上方设为浅灰高光点，渐变到深黑边缘
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.08, cx, cy, r);
      g.addColorStop(0, '#555555');
      g.addColorStop(0.5, '#222222');
      g.addColorStop(1, '#050505');
      ctx.fillStyle = g;
      ctx.fill();
    } else {
      // 白子：亮白高光点渐变到温润象牙灰，并补充细描边使其在浅色木盘上轮廓分明
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.08, cx, cy, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.7, '#f0ede6');
      g.addColorStop(1, '#cfc9be');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#b0a99d';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /**
   * 绘制鼠标悬停磁吸虚影（幽灵棋子）
   * 使用半透明透明度提示玩家如果点击此处将会落下的棋子颜色
   */
  function drawGhostStone(ctx: CanvasRenderingContext2D, x: number, y: number, color: PlayerColor) {
    const cx = PAD + x * CELL;
    const cy = PAD + y * CELL;
    const r = CELL * 0.44;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (color === BLACK) {
      ctx.fillStyle = 'rgba(30, 30, 30, 0.32)';
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(150, 150, 150, 0.4)';
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 绘制获胜五子连线与金色光环
   * 利用 Canvas 的 shadowBlur 与 shadowColor 原生实现光晕(Glow)特效
   */
  function drawWinLine(ctx: CanvasRenderingContext2D, line: Point[]) {
    ctx.save();
    ctx.strokeStyle = '#f59e0b'; // 琥珀金黄色
    ctx.lineWidth = 4;
    ctx.shadowColor = '#f59e0b';
    ctx.shadowBlur = 10; // 金色发光效果

    // 穿过五子中心的折线贯穿
    ctx.beginPath();
    const [p0, ...rest] = line;
    if (p0) {
      ctx.moveTo(PAD + p0[0] * CELL, PAD + p0[1] * CELL);
      for (const p of rest) {
        ctx.lineTo(PAD + p[0] * CELL, PAD + p[1] * CELL);
      }
      ctx.stroke();
    }

    // 在每一个获胜棋子周围套上金色光圈
    for (const [x, y] of line) {
      ctx.beginPath();
      ctx.arc(PAD + x * CELL, PAD + y * CELL, CELL * 0.48, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 当外部依赖属性变化时，重新触发绘制
  useEffect(() => {
    drawBoard();
  }, [drawBoard]);

  /**
   * 处理鼠标/触控指针在棋盘上的移动事件（磁吸计算最近交叉点）
   * 
   * 关键技巧：处理 CSS 缩放自适应 (scale)
   * Canvas 内部固定为 560x560 逻辑像素，但在移动端屏幕上可能被 CSS 缩小（如 360px 宽度）。
   * 必须通过 `canvas.width / rect.width` 计算缩放比，否则点击和悬停点会整体偏移！
   */
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const cx = (e.clientX - rect.left) * scale;
    const cy = (e.clientY - rect.top) * scale;

    // 磁吸四舍五入到最近的网格线索引 (0 ~ 14)
    const x = Math.round((cx - PAD) / CELL);
    const y = Math.round((cy - PAD) / CELL);

    const dummyGame = { size: SIZE };
    if (inBounds(dummyGame as any, x, y)) {
      setHoverPos({ x, y });
    } else {
      setHoverPos(null);
    }
  };

  /**
   * 指针离开画布范围时，清除虚影
   */
  const handlePointerLeave = () => {
    setHoverPos(null);
  };

  /**
   * 处理棋盘点击落子事件
   */
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const cx = (e.clientX - rect.left) * scale;
    const cy = (e.clientY - rect.top) * scale;
    const x = Math.round((cx - PAD) / CELL);
    const y = Math.round((cy - PAD) / CELL);

    const dummyGame = { size: SIZE };
    if (inBounds(dummyGame as any, x, y)) {
      onMove(x, y);
    }
  };

  return (
    <section className={`${styles.boardCard} card board-card`}>
      <div className={`${styles.boardWrap} board-wrap`}>
        {/* HTML5 棋盘画板 */}
        <canvas
          id="board"
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className={styles.canvas}
          onClick={handleClick}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        />

        {/* 蒙层等待提示（等待对端加入房间时覆盖在棋盘上方） */}
        <div
          id="board-overlay"
          className={`${styles.boardOverlay} board-overlay ${showOverlay ? '' : 'hidden'}`}
          style={{ display: showOverlay ? 'flex' : 'none' }}
        >
          <div className={`${styles.overlayInner} overlay-inner`}>
            {/* 三点弹跳加载动画 */}
            <div className={`${styles.overlayDots} overlay-dots`}>
              <i />
              <i />
              <i />
            </div>
            <p id="overlay-text" className={styles.overlayText}>
              {overlayText}
            </p>
          </div>
        </div>

        {/* 结算横幅（对局决出胜负或平局时滑出展示） */}
        <div
          id="result-banner"
          className={`${styles.resultBanner} result-banner ${over ? '' : 'hidden'}`}
          style={{ display: over ? 'flex' : 'none' }}
        >
          <div className={`${styles.resultDot} result-dot`} />
          <div id="result-text" className={styles.resultText}>
            {resultText}
          </div>
          <button
            id="rematch-btn"
            className={`${styles.btn} ${styles.btnPrimary} btn primary`}
            onClick={onRematch}
          >
            再来一局
          </button>
        </div>
      </div>

      {/* 棋盘下方操作栏（悔棋、重开、音效开关与回合提示） */}
      <div className={`${styles.boardActions} board-actions`}>
        <button
          id="undo-btn"
          className={`${styles.btn} btn`}
          disabled={!connected || over || !canUndo}
          onClick={onUndo}
        >
          悔棋
        </button>
        <button
          id="restart-btn"
          className={`${styles.btn} btn`}
          disabled={!connected}
          onClick={onRestart}
        >
          重新开始
        </button>
        <button
          id="sound-btn"
          className={`${styles.btn} ${styles.btnGhost} btn ghost`}
          aria-pressed={soundEnabled}
          onClick={onToggleSound}
        >
          {soundEnabled ? '音效：开' : '音效：关'}
        </button>
        <span className={`${styles.spacer} spacer`} />
        {/* 回合提示文案（如 "黑方执黑先行" 或 "对方正在思考..."） */}
        <span id="turn-hint" className={`${styles.turnHint} hint`}>
          {turnText}
        </span>
      </div>
    </section>
  );
};
