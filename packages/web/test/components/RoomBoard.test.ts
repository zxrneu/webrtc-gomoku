import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BLACK, WHITE, create } from '@webrtc-gomoku/core';
import { PlayerTrays, type PlayerTraysProps } from '../../src/components/Match/PlayerTrays';
import { RoomHeading } from '../../src/components/Match/RoomHeading';
import { Board } from '../../src/components/Board/Board';

const noop = vi.fn();
const players: PlayerTraysProps = {
  black: { name: '松间棋友', tag: '房主 · 我' }, white: { name: '听雨棋友', tag: '棋友' },
  myColor: BLACK, turn: BLACK, moves: [], connected: true, over: false, transport: null, actions: { onPick: noop, onSwap: noop, onName: noop },
};

describe('房间棋盘布局', () => {
  it('棋盒之间直接提供换边入口，说明当前执子', () => {
    const html = renderToStaticMarkup(React.createElement(PlayerTrays, players));
    expect(html).toContain('id="toggle-color-btn"');
    expect(html).toContain('aria-label="当前执黑，申请换边"');
    expect(html.indexOf('id="toggle-color-btn"')).toBeGreaterThan(html.indexOf('id="player-black"'));
    expect(html.indexOf('id="toggle-color-btn"')).toBeLessThan(html.indexOf('id="player-white"'));
  });
  it('自己的昵称可直接修改，对手昵称保持只读', () => {
    const html = renderToStaticMarkup(React.createElement(PlayerTrays, players));
    expect(html).toContain('aria-label="修改我的昵称"');
    expect(html.match(/aria-label="修改我的昵称"/g)).toHaveLength(1);
  });

  it('棋盒旁直接展示昵称和身份，并提示自己的回合拿棋', () => {
    const html = renderToStaticMarkup(React.createElement(PlayerTrays, players));
    expect(html).toContain('松间棋友');
    expect(html).toContain('听雨棋友');
    expect(html).toContain('房主 · 我');
    expect(html).toContain('aria-label="拿起黑棋"');
    expect(html).toContain('aria-label="拿起白棋"');
    expect(html).toContain('拿棋落子');
    expect(html).toMatch(/aria-label="拿起白棋"[^>]*disabled/);
  });

  it.each([
    { turn: WHITE, connected: true, over: false },
    { turn: BLACK, connected: false, over: false },
    { turn: null, connected: true, over: true },
  ])('非自己回合、未连接和终局均不可拿棋：%o', state => {
    const html = renderToStaticMarkup(React.createElement(PlayerTrays, { ...players, ...state }));
    expect(html).toMatch(/aria-label="拿起黑棋"[^>]*disabled/);
    expect(html).toMatch(/aria-label="拿起白棋"[^>]*disabled/);
  });

  it('房间号与邀请、设置入口共用一条棋盘标题栏', () => {
    const html = renderToStaticMarkup(React.createElement(RoomHeading, {
      code: 'ABCD', connected: true, onCopy: noop,
    }));
    expect(html).toContain('id="room-code-text">ABCD');
    expect(html).toContain('id="copy-link-btn"');
    expect(html).not.toContain('room-settings-btn');
    expect(html).toContain('邀请');
  });

  it('棋盒和房间号都在棋盘前，设置不挤占棋盘操作区', () => {
    const game = create();
    const props = {
      board: game.board, moves: [], winLine: null, connected: true, turnText: '轮到你落子', overlayText: '',
      showOverlay: false, over: false, resultText: '', soundEnabled: false, myTurn: true, myColor: BLACK,
      canUndo: false, onMove: noop, onUndo: noop, onRestart: noop, onToggleSound: noop,
      showMoveNumbers: false, onToggleMoveNumbers: noop, onRematch: noop, roomView: true,
      players: React.createElement('div', { id: 'player-trays' }),
      heading: React.createElement('div', { id: 'room-heading' }),
    };
    const html = renderToStaticMarkup(React.createElement(Board, props));
    expect(html).toContain('id="player-trays"');
    expect(html).toContain('id="room-heading"');
    expect(html.indexOf('id="player-trays"')).toBeLessThan(html.indexOf('id="room-heading"'));
    expect(html.indexOf('id="room-heading"')).toBeLessThan(html.indexOf('id="board"'));
  });
});
