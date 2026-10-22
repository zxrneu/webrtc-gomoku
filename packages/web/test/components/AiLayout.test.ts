import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BLACK } from '@webrtc-gomoku/core';
import { createAiGame } from '../../src/ai/aiGame';
import type { AiGameApi } from '../../src/ai/useAiGame';
import { AiPanel } from '../../src/components/AiPanel/AiPanel';
import { Header } from '../../src/components/Header/Header';
import { Board } from '../../src/components/Board/Board';

const noop = vi.fn();
const game = createAiGame();
const api: AiGameApi = {
  aiGame: game, playerColor: BLACK, difficulty: 'hard', pendingDifficulty: 'easy', thinking: false,
  aiLastMove: null, canUndo: false, play: noop, undo: noop, restart: noop, setPlayerColor: noop,
  setDifficulty: noop, backend: 'rust-wasm', setBackend: noop,
  hint: null, hintThinking: false, hintUnavailable: false, canHint: true, requestHint: noop,
};

describe('人机布局集中操作', () => {
  it('顶部引擎选择提供 Rust/WASM 和 TS 并标出当前选择', () => {
    const html = renderToStaticMarkup(React.createElement(AiPanel, { api: { ...api, backend: 'ts' }, over: false }));
    expect(html).toContain('id="ai-backend"');
    expect(html).toContain('aria-label="选择 AI 引擎"');
    expect(html).toContain('<option value="rust-wasm">Rust/WASM</option>');
    expect(html).toContain('<option value="ts" selected="">TS</option>');
  });

  it('顶部设置只保留难度和执子，避免重复对局操作', () => {
    const html = renderToStaticMarkup(React.createElement(AiPanel, { api, over: false }));
    expect(html).toContain('aria-label="选择难度"');
    expect(html).not.toContain('id="ai-color-black-btn"');
    expect(html).not.toContain('id="ai-color-white-btn"');
    expect(html).not.toContain('id="ai-undo-btn"');
    expect(html).not.toContain('id="ai-restart-btn"');
    expect(html).not.toContain('id="ai-hint-btn"');
    expect(html).toContain('下一局生效');
    expect(html).toContain('最强');
  });

  it('页头直接展示人机设置，不必下滑到侧栏', () => {
    const props = { status: 'online' as const, statusText: '人机对战', mode: 'ai' as const,
      onModeChange: noop, children: React.createElement(AiPanel, { api, over: false }) };
    const html = renderToStaticMarkup(React.createElement(Header, props));
    expect(html).toContain('id="ai-difficulty"');
    expect(html.indexOf('id="ai-difficulty"')).toBeLessThan(html.indexOf('</header>'));
  });

  it('棋盘承载提示按钮和说明，并且只渲染一个悔棋入口', () => {
    const props = {
      board: game.board, moves: game.moves, winLine: null, connected: true, turnText: '轮到你落子',
      overlayText: '', showOverlay: false, over: false, resultText: '', soundEnabled: false,
      myTurn: true, myColor: BLACK, canUndo: false, onMove: noop, onUndo: noop, onRestart: noop,
      onToggleSound: noop, showMoveNumbers: false, onToggleMoveNumbers: noop, onRematch: noop,
      extraActions: React.createElement('button', { id: 'ai-hint-btn' }, 'AI 提示'),
      actionDetails: React.createElement('p', { id: 'ai-hint-explanation' }, '推荐 H8'),
    };
    const html = renderToStaticMarkup(React.createElement(Board, props));
    expect(html).toContain('id="ai-hint-btn"');
    expect(html).toContain('id="ai-hint-explanation"');
    expect(html.match(/>悔棋<\/button>/g)).toHaveLength(1);
  });
});
