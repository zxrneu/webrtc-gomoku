import { describe, expect, it } from 'vitest';
import { BLACK, WHITE, create, type GameState, type Point } from '@webrtc-gomoku/core';
import { explainHint } from '../src/ai/aiHint';

function position(stones: readonly Point[], color = BLACK): GameState {
  const game = create();
  for (const [x, y] of stones) game.board[y]![x] = color;
  return game;
}

describe('AI 提示解释', () => {
  it('开局说明中心能向四个方向发展且不改棋盘', () => {
    const game = create();
    const before = JSON.stringify(game);
    expect(explainHint(game, [7, 7], BLACK)?.reasons.join('')).toContain('中心');
    expect(JSON.stringify(game)).toBe(before);
  });

  it.each([
    [[3, 7], [4, 7], [5, 7], [6, 7]],
    [[7, 3], [7, 4], [7, 5], [7, 6]],
    [[3, 3], [4, 4], [5, 5], [6, 6]],
    [[3, 11], [4, 10], [5, 9], [6, 8]],
  ] as Point[][])('四个方向的直接获胜解释来自真实棋形：%j', (...stones) => {
    expect(explainHint(position(stones), [7, 7], BLACK)?.reasons.join('')).toContain('连成五子');
  });

  it('对手下一手可成五时，说明不挡的后果', () => {
    const game = position([[3, 7], [4, 7], [5, 7], [6, 7]], WHITE);
    game.board[7]![2] = BLACK;
    expect(explainHint(game, [7, 7], BLACK)?.reasons.join('')).toContain('对手下一手');
  });

  it('形成活三时解释两端发展的意义', () => {
    const hint = explainHint(position([[5, 7], [6, 7]]), [7, 7], BLACK);
    expect(hint?.reasons.join('')).toContain('横向');
    expect(hint?.reasons.join('')).toContain('活三');
    expect(hint?.reasons.join('')).toContain('两端');
  });

  it('活四解释为什么只堵一端不够', () => {
    const text = explainHint(position([[4, 7], [5, 7], [6, 7]]), [7, 7], BLACK)?.reasons.join('');
    expect(text).toContain('活四');
    expect(text).toContain('另一端');
  });

  it('冲四解释迫使对手防守', () => {
    const game = position([[4, 7], [5, 7], [6, 7]]);
    game.board[7]![3] = WHITE;
    expect(explainHint(game, [7, 7], BLACK)?.reasons.join('')).toContain('迫使对手优先防守');
  });

  it('抢占对手活三发展点时，说明防守的具体目的', () => {
    const text = explainHint(position([[4, 7], [5, 7], [6, 7]], WHITE), [7, 7], BLACK)?.reasons.join('');
    expect(text).toContain('避免对手');
    expect(text).toContain('活四');
  });

  it('可以直接取胜时不要求先堵对方', () => {
    const game = position([[3, 7], [4, 7], [5, 7], [6, 7]]);
    for (const x of [3, 4, 5, 6]) game.board[8]![x] = WHITE;
    const text = explainHint(game, [7, 7], BLACK)?.reasons.join('');
    expect(text).toContain('直接获胜');
    expect(text).not.toContain('先防守');
  });

  it('对手仍可直接成五时，不把己方冲四说成迫使对手防守', () => {
    const game = position([[4, 7], [5, 7], [6, 7]]);
    game.board[7]![3] = WHITE;
    for (const x of [3, 4, 5, 6]) game.board[10]![x] = WHITE;
    const text = explainHint(game, [7, 7], BLACK)?.reasons.join('');
    expect(text).toContain('仍有');
    expect(text).not.toContain('迫使对手');
  });

  it('对手仍可直接成五时，不把己方活四说成挡不住的进攻', () => {
    const game = position([[4, 7], [5, 7], [6, 7]]);
    for (const x of [3, 4, 5, 6]) game.board[10]![x] = WHITE;
    const text = explainHint(game, [7, 7], BLACK)?.reasons.join('');
    expect(text).toContain('仍有');
    expect(text).not.toContain('挡不住');
  });

  it('空盘非中心的合法候选点不会被解释成占据中心', () => {
    const text = explainHint(create(), [0, 0], BLACK)?.reasons.join('');
    expect(text).not.toContain('中心');
  });

  it('白棋提示从玩家视角说明防守', () => {
    const game = position([[3, 7], [4, 7], [5, 7], [6, 7]]);
    game.board[7]![2] = WHITE;
    expect(explainHint(game, [7, 7], WHITE)?.reasons.join('')).toContain('对手下一手');
  });

  it('多个立即成五点时不声称单点防守可解除危机', () => {
    const text = explainHint(position([[3, 7], [4, 7], [5, 7], [6, 7]], WHITE), [7, 7], BLACK)?.reasons.join('');
    expect(text).toContain('仍有');
  });

  it('普通局面明确解释的局限，不虚构必胜', () => {
    const game = position([[0, 0]]);
    expect(explainHint(game, [8, 8], WHITE)?.reasons.join('')).toContain('未形成直接威胁');
  });

  it.each([[1.5, 0], [-1, 0], [15, 0], [0, NaN], [0, 0]] as Point[])('非法或占用点不生成解释 %j', (x, y) => {
    expect(explainHint(position([[0, 0]]), [x, y], BLACK)).toBeNull();
  });

  it('终局不生成提示', () => {
    const game = create();
    game.over = true;
    expect(explainHint(game, [7, 7], BLACK)).toBeNull();
  });
});
