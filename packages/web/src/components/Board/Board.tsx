import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { Color, Move, PlayerColor, Point } from '@webrtc-gomoku/core';
import { SIZE, BLACK, WHITE } from '@webrtc-gomoku/core';
import {
  CANVAS_SIZE,
  CELL,
  COLS,
  LABEL_FONT_SIZE,
  LABEL_INSET,
  PAD,
  STONE_RADIUS,
  pixelToPoint,
  pointToPixel,
} from './geometry';
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
  /** 是否在棋子上展示落子序号 */
  showMoveNumbers: boolean;
  /** 点击切换落子序号展示开关回调 */
  onToggleMoveNumbers: () => void;
  /** 对局结束后点击再来一局回调 */
  onRematch: () => void;
  /**
   * AI 是否正在思考（**可选**，仅人机模式传入）
   * 为 true 时棋盘进入 not-allowed 光标 + 棋盘内浮层提示，点击一律被守卫拦下
   */
  thinking?: boolean;
  /**
   * AI 执子颜色（**可选**，仅人机模式传入）
   * 传入后「最后一手」标记改用与玩家不同的描边样式，便于区分谁刚下过
   */
  aiColor?: PlayerColor;
  hintPoint?: Point | null;
  extraActions?: React.ReactNode;
  actionDetails?: React.ReactNode;
  players?: React.ReactNode;
  heading?: React.ReactNode;
  roomView?: boolean;
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
 * 坐标系换算公式（常量与换算函数集中在 ./geometry，由单测守护）：
 * - 任意交叉点 (x, y) 对应的物理像素中心点为：
 *   px = PAD + x * CELL;
 *   py = PAD + y * CELL;
 */

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
  showMoveNumbers,
  onToggleMoveNumbers,
  onRematch,
  thinking = false,
  aiColor,
  hintPoint,
  extraActions,
  actionDetails,
  players,
  heading,
  roomView = false,
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
    // 字号与内缩距离来自 geometry，保证刻度落在棋子外侧的留白带内，不被首行棋子遮挡
    ctx.font = `${LABEL_FONT_SIZE}px -apple-system, sans-serif`;
    ctx.fillStyle = '#5f4413';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < SIZE; i++) {
      const p = PAD + i * CELL;
      const col = COLS[i] || '';
      const row = String(SIZE - i);
      // 上下边刻度 (A-O)
      ctx.fillText(col, p, LABEL_INSET);
      ctx.fillText(col, p, CANVAS_SIZE - LABEL_INSET);
      // 左右边刻度 (15-1)
      ctx.fillText(row, LABEL_INSET, p);
      ctx.fillText(row, CANVAS_SIZE - LABEL_INSET, p);
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

    // 7. 获胜五子高亮：必须画在棋子之下，否则描边会横穿棋子像「划掉」。
    // 做法是用一条半透明白色胶囊带把五子串起来（连线感），再给每颗子套深琥珀描边环。
    if (winLine && winLine.length >= 5) {
      drawWinHighlight(ctx, winLine);
    }

    // 8. 遍历全盘矩阵，绘制所有已落下的棋子
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = board[y]?.[x];
        if (c === BLACK || c === WHITE) {
          drawStone(ctx, x, y, c);
        }
      }
    }

    // 9. 绘制鼠标悬停磁吸预览虚影（半透明幽灵棋子）
    // 触发条件：当前处于自己的回合、已连线、游戏未结束、且该交叉点尚未落子
    if (hoverPos && connected && !over && myTurn) {
      const { x, y } = hoverPos;
      if (board[y]?.[x] === 0) {
        drawGhostStone(ctx, x, y, myColor);
      }
    }

    // 10. 最后一手落子醒目标记
    if (moves.length > 0) {
      const last = moves[moves.length - 1]!;
      const { px: lx, py: ly } = pointToPixel(last.x, last.y);
      if (showMoveNumbers) {
        // 当开启手数显示时，最后一手标记在棋子右上角，避免遮挡中心数字
        ctx.beginPath();
        ctx.arc(lx + 8.5, ly - 8.5, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (aiColor !== undefined && last.c === aiColor) {
        // 人机模式：AI 的最后一手用「蓝色空心环」区分（PRD P1-4）；
        // aiColor 未传时这条分支永不进入，联机路径保持原有红点行为不变
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // 未开启手数时，保持正中央经典红点
        ctx.beginPath();
        ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = last.c === BLACK ? '#f87171' : '#dc2626';
        ctx.fill();
      }
    }

    // 11. 手数标注（从 1 开始累加渲染在棋子正中央）
    if (showMoveNumbers && moves.length > 0) {
      drawMoveNumbers(ctx, moves);
    }
  }, [board, moves, winLine, hoverPos, connected, over, myTurn, myColor, showMoveNumbers, aiColor]);


  /**
   * 绘制单枚立体棋子（黑子/白子）
   * 技巧：通过微小偏移绘制柔和投影，搭配偏心径向高光渐变，营造真实云子微凸的鹅卵石触感
   */
  function drawStone(ctx: CanvasRenderingContext2D, x: number, y: number, color: PlayerColor) {
    const { px: cx, py: cy } = pointToPixel(x, y);
    const r = STONE_RADIUS;

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
    const { px: cx, py: cy } = pointToPixel(x, y);
    const r = STONE_RADIUS;

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
   * 绘制获胜五子高亮（**必须画在棋子之前**，否则描边横穿棋子像「划掉」）
   *
   * 旧实现是 4px 金色实线穿过棋子中心，在木色上对比度仅 1.29:1，几乎看不见。
   * 改为「半透明白色胶囊带 + 深琥珀描边环」：胶囊带负责连线感，
   * 描边环负责逐颗强调，两者都落在棋子外缘，不遮挡棋子本体。
   */
  function drawWinHighlight(ctx: CanvasRenderingContext2D, line: Point[]) {
    const head = line[0];
    const tail = line[line.length - 1];
    if (!head || !tail) return;

    ctx.save();
    // 1. 半透明暖白色胶囊带：把制胜五子串成一条高亮轨道
    const from = pointToPixel(head[0], head[1]);
    const to = pointToPixel(tail[0], tail[1]);
    ctx.strokeStyle = 'rgba(255, 248, 230, 0.55)';
    ctx.lineWidth = CELL * 0.98;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.px, from.py);
    ctx.lineTo(to.px, to.py);
    ctx.stroke();

    // 2. 每颗制胜棋子的深琥珀描边环（#92400e 在木色上对比度 > 6:1）
    // 半径只比棋子大 2.5px：相邻环之间留出细微间隙，五颗连成一串「珠链」而不是糊成一片
    ctx.strokeStyle = 'rgba(146, 64, 14, 0.92)';
    ctx.lineWidth = 2;
    for (const [x, y] of line) {
      const { px, py } = pointToPixel(x, y);
      ctx.beginPath();
      ctx.arc(px, py, STONE_RADIUS + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 绘制棋子中心落子手数序号
   * 视觉规范：黑子白色文字、白子深色文字，居中清晰无遮挡
   */
  function drawMoveNumbers(ctx: CanvasRenderingContext2D, movesList: Move[]) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < movesList.length; i++) {
      const m = movesList[i]!;
      const { px: mx, py: my } = pointToPixel(m.x, m.y);
      const num = i + 1;
      ctx.font = num >= 100
        ? 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        : 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = m.c === BLACK ? '#ffffff' : '#1e293b';
      ctx.fillText(String(num), mx, my);
    }
    ctx.restore();
  }

  // 当外部依赖属性变化时，重新触发绘制
  useEffect(() => {
    drawBoard();

  }, [drawBoard]);

  /**
   * 把指针事件换算成棋盘交叉点（处理 CSS 缩放自适应）
   *
   * Canvas 内部固定为 560x560 逻辑像素，但在移动端屏幕上可能被 CSS 缩小（如 360px 宽度）。
   * 必须通过 `canvas.width / rect.width` 计算缩放比，否则点击和悬停点会整体偏移！
   * 命中与吸附规则统一由 geometry.pixelToPoint 负责，绘制与交互共用同一套坐标。
   */
  const toBoardPoint = (
    e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>,
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    return pixelToPoint((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale);
  };

  /**
   * 处理鼠标/触控指针在棋盘上的移动事件（磁吸计算最近交叉点）
   * 同一交叉点内移动不触发重绘：整盘 225 颗棋子全量重绘没必要，也避免高频 pointermove 抖动
   */
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toBoardPoint(e);
    setHoverPos((prev) =>
      prev && point && prev.x === point.x && prev.y === point.y ? prev : point,
    );
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
    const point = toBoardPoint(e);
    if (point) onMove(point.x, point.y);
  };

  return (
    <section className={`${styles.boardCard} ${roomView ? styles.roomMatch : ''} card board-card`}>
      {players}
      {heading}
      <div className={`${styles.boardWrap} board-wrap`}>
        {/* HTML5 棋盘画板 */}
        <canvas
          id="board"
          tabIndex={roomView ? 0 : undefined}
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className={`${styles.canvas} ${thinking ? styles.canvasThinking : ''}`}
          aria-disabled={thinking}
          onClick={handleClick}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        />

        {hintPoint && !over && board[hintPoint[1]]?.[hintPoint[0]] === 0 && (
          <span id="ai-hint-marker" className={styles.hintMarker} aria-label="AI 推荐落子位置"
            style={{ left: `${(PAD + hintPoint[0] * CELL) / CANVAS_SIZE * 100}%`,
              top: `${(PAD + hintPoint[1] * CELL) / CANVAS_SIZE * 100}%` }} />
        )}

        {/* AI 思考浮层条（人机模式专用）：thinking=false 时不渲染，联机路径零变化 */}
        {thinking && (
          <div
            id="board-thinking"
            className={`${styles.thinkingBar} board-thinking`}
            aria-live="polite"
          >
            <span className={styles.thinkingDot} />
            AI 正在思考…
          </div>
        )}

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
      <div className={`${styles.boardActions} ${extraActions ? styles.withExtras : ''} board-actions`}>
        {extraActions}
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
          disabled={!connected || thinking}
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
        <button
          id="toggle-move-numbers-btn"
          className={`${styles.btn} ${styles.btnGhost} btn ghost`}
          aria-pressed={showMoveNumbers}
          onClick={onToggleMoveNumbers}
        >
          {showMoveNumbers ? '隐藏手数' : '显示手数'}
        </button>
        <span className={`${styles.spacer} spacer`} />

        {/* 回合提示文案（如 "黑方执黑先行" 或 "对方正在思考..."） */}
        <span id="turn-hint" className={`${styles.turnHint} hint`}>
          {turnText}
        </span>
      </div>
      {actionDetails && <div className={styles.actionDetails}>{actionDetails}</div>}
    </section>
  );
};
