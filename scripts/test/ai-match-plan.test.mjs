import { describe, expect, it } from 'vitest';
import { planMatches, replayMatch, summarizeMatches } from '../lib/ai-match-plan.mjs';

const five = [[3,7],[0,0],[4,7],[0,2],[5,7],[0,4],[6,7],[0,6],[7,7]];

describe('three-engine tournament', () => {
  it('schedules 24 games with every pair balanced by opening and color', () => {
    const plan = planMatches();
    expect(plan).toHaveLength(24);
    expect(new Set(plan.map(g => g.id)).size).toBe(24);
    expect(plan.filter(g => g.timeBudgetMs === 500)).toHaveLength(18);
    expect(plan.filter(g => g.timeBudgetMs === 3000)).toHaveLength(6);
    for (const a of ['ts', 'rust-wasm', 'native-rust']) {
      expect(plan.filter(g => g.black === a)).toHaveLength(8);
      expect(plan.filter(g => g.white === a)).toHaveLength(8);
      for (const b of ['ts', 'rust-wasm', 'native-rust'].filter(b => b !== a)) {
        const forward = plan.filter(g => g.black === a && g.white === b);
        const backward = plan.filter(g => g.white === a && g.black === b);
        expect(forward).toHaveLength(4);
        expect(forward.map(g => [g.opening, g.timeBudgetMs]))
          .toEqual(backward.map(g => [g.opening, g.timeBudgetMs]));
      }
    }
  });

  it('keeps forced opening samples explicit and independent of each game', () => {
    const plan = planMatches();
    expect(new Set(plan.map(g => JSON.stringify(g.opening))).size).toBe(3);
    plan[0].opening.push([0,0]);
    expect(plan[1].opening).toEqual([]);
  });

  it('replays a real five and reports the winning color', () => {
    expect(replayMatch(five)).toEqual({winnerColor: 1, plies: 9});
    expect(replayMatch(five.map(([x,y]) => [y,x]))).toEqual({winnerColor: 1, plies: 9});
  });

  it('rejects incomplete games rather than counting them as draws', () => {
    expect(() => replayMatch([])).toThrow(/unfinished/);
    expect(() => replayMatch(five.slice(0, -1))).toThrow(/unfinished/);
  });

  it('rejects illegal moves and moves after the terminal position', () => {
    expect(() => replayMatch([[7,7],[7,7]])).toThrow(/illegal/);
    expect(() => replayMatch([[15,0]])).toThrow(/illegal/);
    expect(() => replayMatch([...five,[1,1]])).toThrow(/illegal/);
  });

  it('counts game results separately from per-move proof and fallback statistics', () => {
    const games = [
      {status:'complete', black:'ts', white:'native-rust', winnerColor:1,
        moves:[{engine:'native-rust',source:'ordering',proofStatus:'unknown'}, {engine:'ts',proofStatus:'win'}]},
      {status:'complete', black:'native-rust', white:'rust-wasm', winnerColor:2,
        moves:[{engine:'native-rust',source:'proof',proofStatus:'win'}]},
      {status:'running', black:'native-rust', white:'ts', moves:[]},
    ];
    const summary = summarizeMatches(games);
    expect(summary.completed).toBe(2);
    expect(summary.players['native-rust']).toEqual({games:2,wins:0,losses:2,draws:0,blackWins:0,whiteWins:0,
      moves:2,provenMoves:1,fallbackMoves:1});
    expect(summary.players.ts.wins).toBe(1);
    expect(summary.players['rust-wasm'].whiteWins).toBe(1);
  });
});
