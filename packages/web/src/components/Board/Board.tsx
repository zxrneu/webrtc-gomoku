import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { Color, Move, PlayerColor, Point } from '@webrtc-gomoku/core';
import { SIZE, BLACK, WHITE, inBounds } from '@webrtc-gomoku/core';
import styles from './Board.module.css';

interface BoardProps {
  board: Color[][];
  moves: Move[];
  winLine: Point[] | null;
  connected: boolean;
  turnText: string;
  overlayText: string;
  showOverlay: boolean;
  over: boolean;
  resultText: string;
  soundEnabled: boolean;
  myTurn: boolean;
  myColor: PlayerColor;
  canUndo: boolean;
  onMove: (x: number, y: number) => void;
  onUndo: () => void;
  onRestart: () => void;
  onToggleSound: () => void;
  onRematch: () => void;
}

const CELL = 36;
const PAD = 28;
const CANVAS_SIZE = (SIZE - 1) * CELL + PAD * 2; // 560
const COLS = 'ABCDEFGHIJKLMNO';

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const drawBoard = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 清屏并绘制温润木质棋盘背景
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    const grad = ctx.createRadialGradient(
      CANVAS_SIZE / 2,
      CANVAS_SIZE / 2,
      20,
      CANVAS_SIZE / 2,
      CANVAS_SIZE / 2,
      CANVAS_SIZE * 0.7
    );
    grad.addColorStop(0, '#e8c47b');
    grad.addColorStop(1, '#d5aa53');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 棋盘细微木纹
    ctx.strokeStyle = 'rgba(110, 80, 30, 0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i < CANVAS_SIZE; i += 6) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(CANVAS_SIZE, i);
      ctx.stroke();
    }

    // 坐标标尺 A-O 与 1-15
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = '#7a5924';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < SIZE; i++) {
      const p = PAD + i * CELL;
      const col = COLS[i] || '';
      const row = String(15 - i);
      ctx.fillText(col, p, 12);
      ctx.fillText(col, p, CANVAS_SIZE - 12);
      ctx.fillText(row, 12, p);
      ctx.fillText(row, CANVAS_SIZE - 12, p);
    }

    // 网格线
    ctx.strokeStyle = '#704f1a';
    ctx.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      const p = PAD + i * CELL;
      // 横线
      ctx.beginPath();
      ctx.moveTo(PAD, p);
      ctx.lineTo(CANVAS_SIZE - PAD, p);
      ctx.stroke();
      // 竖线
      ctx.beginPath();
      ctx.moveTo(p, PAD);
      ctx.lineTo(p, CANVAS_SIZE - PAD);
      ctx.stroke();
    }

    // 外部双线加粗
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, PAD, (SIZE - 1) * CELL, (SIZE - 1) * CELL);

    // 星位 (天元及4个角星)
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

    // 绘制落子
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = board[y]?.[x];
        if (c === BLACK || c === WHITE) {
          drawStone(ctx, x, y, c);
        }
      }
    }

    // 悬停预览虚影
    if (hoverPos && connected && !over && myTurn) {
      const { x, y } = hoverPos;
      if (board[y]?.[x] === 0) {
        drawGhostStone(ctx, x, y, myColor);
      }
    }

    // 最后一手红点标记
    if (moves.length > 0) {
      const last = moves[moves.length - 1]!;
      const lx = PAD + last.x * CELL;
      const ly = PAD + last.y * CELL;
      ctx.beginPath();
      ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = last.c === BLACK ? '#f87171' : '#dc2626';
      ctx.fill();
    }

    // 胜利连线高亮
    if (winLine && winLine.length >= 5) {
      drawWinLine(ctx, winLine);
    }
  }, [board, moves, winLine, hoverPos, connected, over, myTurn, myColor]);

  function drawStone(ctx: CanvasRenderingContext2D, x: number, y: number, color: PlayerColor) {
    const cx = PAD + x * CELL;
    const cy = PAD + y * CELL;
    const r = CELL * 0.44;

    // 阴影
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx + 1.5, cy + 2.5, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (color === BLACK) {
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.08, cx, cy, r);
      g.addColorStop(0, '#555555');
      g.addColorStop(0.5, '#222222');
      g.addColorStop(1, '#050505');
      ctx.fillStyle = g;
      ctx.fill();
    } else {
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

  function drawWinLine(ctx: CanvasRenderingContext2D, line: Point[]) {
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#f59e0b';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    const [p0, ...rest] = line;
    if (p0) {
      ctx.moveTo(PAD + p0[0] * CELL, PAD + p0[1] * CELL);
      for (const p of rest) {
        ctx.lineTo(PAD + p[0] * CELL, PAD + p[1] * CELL);
      }
      ctx.stroke();
    }

    for (const [x, y] of line) {
      ctx.beginPath();
      ctx.arc(PAD + x * CELL, PAD + y * CELL, CELL * 0.48, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  useEffect(() => {
    drawBoard();
  }, [drawBoard]);

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
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
      setHoverPos({ x, y });
    } else {
      setHoverPos(null);
    }
  };

  const handlePointerLeave = () => {
    setHoverPos(null);
  };

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

        {/* 蒙层提示 */}
        <div
          id="board-overlay"
          className={`${styles.boardOverlay} board-overlay ${showOverlay ? '' : 'hidden'}`}
          style={{ display: showOverlay ? 'flex' : 'none' }}
        >
          <div className={`${styles.overlayInner} overlay-inner`}>
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

        {/* 结算横幅 */}
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
        <span id="turn-hint" className={`${styles.turnHint} hint`}>
          {turnText}
        </span>
      </div>
    </section>
  );
};
