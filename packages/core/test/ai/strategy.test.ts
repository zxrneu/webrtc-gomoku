import { describe, expect, it } from 'vitest';
import { BLACK, WHITE, applyMove, createProofSession, loadWinningStrategy, type GameState } from '../../src/index';
import { buildAlternating, cloneGame } from './helpers';

function certificate() {
  const game = buildAlternating([[4, 7], [5, 7], [6, 7]], [[0, 0], [0, 2], [14, 14]]);
  const session = createProofSession(game, BLACK);
  while (session.step()) { /* 求解一个短的完整胜法 */ }
  const result = session.result();
  if (result.status !== 'win') throw new Error('fixture must be proven');
  return { format: 'gomoku-proof-v1', rules: 'freestyle-15', game, attacker: BLACK, proof: result.proof };
}

describe('经过验证的策略保存与执行', () => {
  it('导入证书后给出首手，并覆盖对手不防守的合法应手', () => {
    const document = certificate();
    const strategy = loadWinningStrategy(document);
    expect(strategy).not.toBeNull();
    if (!strategy) return;
    const game = cloneGame(document.game);
    const first = strategy.moveFor(game);
    expect(first).not.toBeNull();
    if (!first) return;
    applyMove(game, first[0], first[1], BLACK);
    applyMove(game, 14, 0, WHITE);
    const win = strategy.moveFor(game);
    expect(win).not.toBeNull();
    if (win) expect(applyMove(game, win[0], win[1], BLACK)).toMatchObject({ ok: true, event: 'win' });
  });

  it('证书能 JSON 往返，外部修改原文档或导出副本不影响策略', () => {
    const document = certificate();
    const strategy = loadWinningStrategy(JSON.parse(JSON.stringify(document)));
    expect(strategy).not.toBeNull();
    if (!strategy) return;
    const expected = strategy.moveFor(document.game);
    const saved = strategy.toJSON();
    saved.proof.at = 225;
    expect(strategy.moveFor(document.game)).toEqual(expected);
    expect(loadWinningStrategy(strategy.toJSON())?.moveFor(document.game)).toEqual(expected);
  });

  it('不接受错误规则、伪造证明或不属于策略的局面', () => {
    const document = certificate();
    expect(loadWinningStrategy({ ...document, rules: 'renju' })).toBeNull();
    expect(loadWinningStrategy({ ...document, proof: { kind: 'five', at: 0 } })).toBeNull();
    expect(loadWinningStrategy(null)).toBeNull();
    const strategy = loadWinningStrategy(document);
    const changed: GameState = cloneGame(document.game);
    applyMove(changed, 10, 10, BLACK);
    applyMove(changed, 10, 11, WHITE);
    expect(strategy?.moveFor(changed)).toBeNull();
    expect(strategy?.moveFor({ ...changed, over: true })).toBeNull();
  });
});

it('策略后续证明仍属于当前局面，附带的循环垃圾字段不会进入导出', () => {
  const document = certificate();
  const noisy = { ...document, extra: {} };
  noisy.extra = noisy;
  const strategy = loadWinningStrategy(noisy);
  expect(strategy).not.toBeNull();
  if (!strategy) return;
  const game = cloneGame(document.game);
  const first = strategy.moveFor(game);
  if (!first) throw new Error('missing first move');
  applyMove(game, first[0], first[1], BLACK);
  applyMove(game, 14, 0, WHITE);
  expect(strategy.proofFor(game)?.kind).toBe('five');
  expect(JSON.stringify(strategy.toJSON())).not.toContain('extra');
});
