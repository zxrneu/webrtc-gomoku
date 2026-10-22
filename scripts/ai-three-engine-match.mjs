/** Actual web search versus a benchmark-only, wholly native Rust proof/fallback player. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { applyMove, create, currentColor, loadWinningStrategy, verifyWinningProof } from '../packages/core/dist/index.mjs';
import { createSearchWorkerHandler } from '../packages/web/src/ai/workerRuntime.ts';
import { planMatches, replayMatch, summarizeMatches } from './lib/ai-match-plan.mjs';

const root = fileURLToPath(new URL('..',import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.every(arg => ['--smoke','--resume'].includes(arg) || arg.startsWith('--output=')), 'unsupported argument');
const smoke = args.includes('--smoke');
const output = path.resolve(root,args.find(arg => arg.startsWith('--output='))?.slice(9) ??
  `output/ai-three-engine-${smoke ? 'smoke' : 'matches'}`);
const binary = path.join(root,'crates/gomoku-solver/target/release/examples/match-player');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceRevision = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const nativeMaxNodes = 100000;
const plan = smoke ? planMatches().slice(0,6).map(game => ({...game,
  openingName:'forced-four-smoke',opening:[[4,7],[0,0],[5,7],[0,2],[6,7],[14,14]],timeBudgetMs:100})) : planMatches();
const identity = {
  sourceRevision, nativeBinarySha256:hash(fs.readFileSync(binary)),
  runnerSha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  planSha256:hash(JSON.stringify(plan)),
};
const resultFile = path.join(output,'matches.json');
let document = {format:'gomoku-three-engine-matches-v1',...identity,
  startedAt:new Date().toISOString(),platform:`${process.version} ${process.platform}/${process.arch}`,
  nativePolicy:'verified strategy; tactical proof search (75% time); DFPN (remaining time); native immediate-win/block/window ordering fallback',
  nativeMaxNodesPerPhase:nativeMaxNodes,webOptions:{difficulty:'hard'},plan,games:[]};
fs.mkdirSync(path.join(output,'proofs'),{recursive:true});
if (args.includes('--resume') && fs.existsSync(resultFile)) {
  const previous = JSON.parse(fs.readFileSync(resultFile,'utf8'));
  for (const key of Object.keys(identity)) assert.equal(previous[key],identity[key],`resume mismatch: ${key}`);
  document = {...previous,games:previous.games.filter(game => game.status === 'complete')};
  for (const game of document.games) assert.deepEqual(replayMatch(game.history),{winnerColor:game.winnerColor,plies:game.plies});
} else assert.ok(!fs.existsSync(resultFile),'output exists; use --resume or choose a new output directory');

function save() {
  document.summary = summarizeMatches(document.games);
  fs.writeFileSync(`${resultFile}.tmp`,JSON.stringify(document,null,2)+'\n');
  fs.renameSync(`${resultFile}.tmp`,resultFile);
}

function webPlayer(backend,timeBudgetMs) {
  const queue = [];
  let reply = null;
  let id = 0;
  const handler = createSearchWorkerHandler(value => {reply=value;}, {
    now:()=>performance.now(),schedule:callback=>queue.push(callback),
  });
  return {close:async()=>{},move:async game => {
    reply = null;
    handler({t:'search',id:++id,game,color:currentColor(game),options:{difficulty:'hard',backend,timeBudgetMs}});
    while (queue.length) queue.shift()();
    assert.ok(reply?.move,'web search returned no move');
    const stats = reply.stats;
    assert.ok(stats.backend === backend || (stats.nodes === 0 && stats.proofStatus === 'win'), 'unexpected scoring fallback');
    return {move:reply.move,stats:{...stats,winningProof:undefined},proof:stats.winningProof,
      source:stats.proofStatus === 'win' ? (stats.nodes === 0 ? 'cached-proof' : 'proof') : 'search'};
  }};
}

function nativePlayer(timeBudgetMs) {
  const child = spawn(binary,[],{cwd:root,stdio:['pipe','pipe','pipe']});
  const lines = createInterface({input:child.stdout});
  let stderr = '';
  child.stderr.on('data',chunk => {stderr=(stderr+chunk).slice(-8192);});
  let pending = null;
  const exited = new Promise(resolve => child.once('exit',resolve));
  child.on('error',error => pending?.reject(error));
  child.on('exit',code => pending?.reject(new Error(`native player exited ${code}: ${stderr}`)));
  lines.on('line',line => {
    const request = pending;
    pending = null;
    if (!request) return;
    clearTimeout(request.timer);
    try { request.resolve(JSON.parse(line)); } catch (error) { request.reject(error); }
  });
  return {close:async()=>{child.stdin.end();await exited;lines.close();},move:async game => {
    const value = await new Promise((resolve,reject) => {
      const timer = setTimeout(()=>{child.kill();reject(new Error('native player exceeded 30s watchdog; game is incomplete'));},30000);
      pending = {resolve,reject,timer};
      child.stdin.write(JSON.stringify({moves:game.moves.map(m=>[m.x,m.y]),timeBudgetMs,maxNodes:nativeMaxNodes})+'\n');
    });
    assert.equal(value.ok,true,value.error);
    const {move,certificate,source,proofStatus,tacticalNodes,dfpnExpansions} = value.result;
    let proof;
    if (proofStatus === 'win') {
      const strategy = loadWinningStrategy(certificate);
      assert.ok(strategy,'TS rejected native Rust certificate');
      proof = strategy.proofFor(game);
      assert.ok(proof,'native certificate does not cover current position');
    } else assert.equal(certificate,null,'unknown response must not claim a certificate');
    return {move,source,proof,stats:{proofStatus,tacticalNodes,dfpnExpansions,backend:'native-rust'}};
  }};
}

function checkProof(game,reply) {
  if (reply.stats.proofStatus !== 'win') return null;
  assert.equal(verifyWinningProof(game,currentColor(game),reply.proof),true,'independent TS proof verification failed');
  assert.equal(reply.proof.at,reply.move[1]*15+reply.move[0],'move disagrees with proof');
  const certificate = {format:'gomoku-proof-v1',rules:'freestyle-15',game,attacker:currentColor(game),proof:reply.proof};
  const data = JSON.stringify(certificate);
  const proofSha256 = hash(data);
  fs.writeFileSync(path.join(output,'proofs',`${proofSha256}.json`),data+'\n');
  return proofSha256;
}

async function play(spec) {
  const players = Object.fromEntries([spec.black,spec.white].map(engine => [engine,
    engine === 'native-rust' ? nativePlayer(spec.timeBudgetMs) : webPlayer(engine,spec.timeBudgetMs)]));
  const game = create();
  for (const [x,y] of spec.opening) assert.equal(applyMove(game,x,y,currentColor(game)).ok,true);
  const row = {...spec,status:'running',moves:[],history:structuredClone(spec.opening),startedAt:new Date().toISOString()};
  document.games.push(row);
  const started = performance.now();
  try {
    while (!game.over) {
      const color = currentColor(game);
      const engine = color === 1 ? spec.black : spec.white;
      const before = JSON.stringify(game);
      const start = performance.now();
      const reply = await players[engine].move(game);
      const wallMs = performance.now()-start;
      assert.equal(JSON.stringify(game),before,'search mutated public input');
      const proofSha256 = checkProof(game,reply);
      const [x,y] = reply.move;
      assert.equal(applyMove(game,x,y,color).ok,true,'engine returned an illegal move');
      row.moves.push({ply:game.moves.length,color,engine,x,y,wallMs,source:reply.source,proofSha256,...reply.stats});
      row.history.push([x,y]);
      save();
      if (row.moves.length % 8 === 0) process.stdout.write(`${spec.id}: ply ${game.moves.length}\n`);
      await new Promise(setImmediate);
    }
    Object.assign(row,replayMatch(row.history),{status:'complete',wallMs:performance.now()-started});
    row.finishedAt = new Date().toISOString();
    process.stdout.write(`${spec.id}: ${row.winnerColor === 1 ? spec.black : row.winnerColor === 2 ? spec.white : 'draw'} (${row.plies} plies)\n`);
  } catch (error) {
    row.status = 'incomplete';
    row.error = String(error);
    throw error;
  } finally {
    save();
    for (const player of Object.values(players)) await player.close();
  }
}

// Warm both production paths before timing games. No concurrent timed matches or build processes.
for (const backend of ['ts','rust-wasm']) {
  const game = create();
  for (const [x,y] of planMatches().find(game => game.openingName === 'cluster-6').opening) applyMove(game,x,y,currentColor(game));
  await webPlayer(backend,100).move(game);
}
save();
for (const spec of plan) if (!document.games.some(game => game.id === spec.id && game.status === 'complete')) await play(spec);
document.finishedAt = new Date().toISOString();
save();
process.stdout.write(JSON.stringify(document.summary)+'\n');
