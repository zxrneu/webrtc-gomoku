import assert from 'node:assert/strict';
import { applyMove, create, currentColor } from '../../packages/core/dist/index.mjs';

const engines = ['ts', 'rust-wasm', 'native-rust'];
const openings = [
  {name:'empty', moves:[]},
  {name:'cluster-6', moves:[[7,7],[8,7],[6,6],[9,8],[6,8],[7,9]]},
  {name:'scattered-12', moves:[[7,7],[9,7],[6,5],[8,9],[5,8],[10,6],[9,10],[4,6],[8,4],[5,10],[10,9],[3,8]]},
];

/** Three pairs × two colors × (three short openings + one default-budget opening). */
export function planMatches() {
  const pairs = engines.flatMap((a,index) => engines.slice(index+1)
    .flatMap(b => [[a,b],[b,a]]));
  const samples = [
    ...openings.map(opening => ({opening,timeBudgetMs:500})),
    {opening:openings[0],timeBudgetMs:3000},
  ];
  return samples.flatMap(({opening,timeBudgetMs}) => pairs.map(([black,white]) => ({
    id:`${timeBudgetMs}-${opening.name}-${black}-black-${white}`,
    black,white,openingName:opening.name,opening:structuredClone(opening.moves),timeBudgetMs,
  })));
}

function countRay(board,stone,[dx,dy]) {
  let count = 0;
  for (let step = 1; step < 15; step++) {
    if (board[stone.y+dy*step]?.[stone.x+dx*step] !== stone.c) break;
    count++;
  }
  return count;
}

/** Require a legal terminal game and independently count the final stone's four lines. */
export function replayMatch(moves) {
  const game = create();
  for (const [x,y] of moves) {
    const result = applyMove(game,x,y,currentColor(game));
    assert.equal(result.ok,true,'illegal move in replay');
  }
  assert.equal(game.over,true,'unfinished game');
  const last = game.moves.at(-1);
  let winnerColor = 0;
  for (const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    const count = 1+countRay(game.board,last,[dx,dy])+countRay(game.board,last,[-dx,-dy]);
    if (count >= 5) winnerColor = last.c;
  }
  assert.equal(Boolean(game.winLine),winnerColor !== 0,'independent winner mismatch');
  assert.ok(winnerColor || game.moves.length === 225,'draw requires a full board');
  return {winnerColor,plies:game.moves.length};
}

export function summarizeMatches(games) {
  const players = Object.fromEntries(engines.map(engine => [engine, {
    games:0,wins:0,losses:0,draws:0,blackWins:0,whiteWins:0,moves:0,provenMoves:0,fallbackMoves:0,
  }]));
  const completed = games.filter(game => game.status === 'complete');
  for (const game of completed) {
    for (const [color,engine] of [[1,game.black],[2,game.white]]) {
      const row = players[engine];
      row.games++;
      if (!game.winnerColor) row.draws++;
      else if (game.winnerColor === color) {
        row.wins++;
        row[color === 1 ? 'blackWins' : 'whiteWins']++;
      } else row.losses++;
    }
    for (const move of game.moves) {
      const row = players[move.engine];
      row.moves++;
      if (move.proofStatus === 'win') row.provenMoves++;
      else if (move.engine === 'native-rust') row.fallbackMoves++;
    }
  }
  return {completed:completed.length,players};
}
