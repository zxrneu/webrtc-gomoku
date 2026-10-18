/** 离线求解/复验入口；unknown 结果永远不写成胜法证书。 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { create, applyMove, currentColor, createProofSession, loadWinningStrategy } from '../packages/core/dist/index.mjs';

function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function gameFrom(input) {
  if (!record(input) || !Array.isArray(input.moves)) throw new Error('输入必须包含 moves 坐标数组');
  const game = create();
  for (const point of input.moves) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger)) throw new Error('落子坐标必须为两个整数');
    const move = applyMove(game, point[0], point[1], currentColor(game));
    if (!move.ok || game.over) throw new Error('输入须为合法、未结束的交替落子序列');
  }
  return game;
}
function optionsFrom(input) {
  const options = input.options ?? {};
  if (!record(options)) throw new Error('options 必须为对象');
  for (const key of Object.keys(options)) {
    if (!['maxNodes', 'maxAttacks', 'timeBudgetMs', 'mode', 'algorithm'].includes(key)) throw new Error(`未知参数 ${key}`);
    if (!['mode', 'algorithm'].includes(key) && (!Number.isFinite(options[key]) || options[key] < 0)) throw new Error(`${key} 必须为非负有限数`);
  }
  if (options.algorithm !== undefined && !['dfs', 'pn'].includes(options.algorithm)) throw new Error('未知搜索算法');
  if (options.mode !== undefined && !['fours', 'threats', 'complete'].includes(options.mode)) throw new Error('未知搜索模式');
  return { maxNodes: 50000, maxAttacks: 12, timeBudgetMs: 10000, mode: 'complete', ...options, now: () => performance.now() };
}
async function solve(inputPath, outputPath) {
  if (!inputPath || !outputPath) throw new Error('用法: ai:prove <输入.json> <新的输出.json>');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const game = gameFrom(input);
  const attacker = currentColor(game);
  const session = createProofSession(game, attacker, optionsFrom(input));
  while (session.step(32)) await new Promise((resolve) => setImmediate(resolve));
  const result = session.result();
  const document = result.status === 'win'
    ? { format: 'gomoku-proof-v1', rules: 'freestyle-15', game, attacker, proof: result.proof }
    : { format: 'gomoku-search-v1', game, attacker, ...result };
  if (result.status === 'win' && !loadWinningStrategy(document)) throw new Error('独立复验未通过，拒绝写入证书');
  fs.writeFileSync(outputPath, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: result.status, nodes: result.nodes, output: outputPath,
    ...(result.status === 'unknown' ? { reason: result.reason } : { verified: true }) }) + '\n');
  if (result.status === 'unknown') process.exitCode = 2;
}
try {
  const [command, input, output] = process.argv.slice(2);
  if (command === 'solve') await solve(input, output);
  else if (command === 'verify' && input) {
    const strategy = loadWinningStrategy(JSON.parse(fs.readFileSync(input, 'utf8')));
    process.stdout.write(JSON.stringify({ verified: strategy !== null }) + '\n');
    if (!strategy) process.exitCode = 1;
  } else throw new Error('用法: ai:prove <输入.json> <新的输出.json> 或 ai:verify <证书.json>');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
