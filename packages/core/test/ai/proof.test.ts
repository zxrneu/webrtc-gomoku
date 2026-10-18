import { describe, expect, it } from 'vitest';
import { BLACK, WHITE, create, createProofSession, verifyWinningProof, type GameState, type Point } from '../../src/index';
import { buildAlternating } from './helpers';

function finish(game: GameState, maxAttacks = 3, maxNodes = 1000) {
  const session = createProofSession(game, BLACK, { maxAttacks, maxNodes });
  while (session.step()) { /* 节点预算使无时间源求解也必定收敛 */ }
  return session.result();
}
const three = (): GameState => buildAlternating([[4, 7], [5, 7], [6, 7]], [[0, 0], [0, 2], [14, 14]]);

describe('可验证的无禁手胜法', () => {
  it.each([
    [[3, 7], [4, 7], [5, 7], [6, 7]],
    [[7, 3], [7, 4], [7, 5], [7, 6]],
    [[3, 3], [4, 4], [5, 5], [6, 6]],
    [[3, 9], [4, 8], [5, 7], [6, 6]],
  ] as Point[][])('四方向的一步胜生成可独立验证的证明 %j', (...points) => {
    const game = buildAlternating(points, [[0, 0], [0, 2], [14, 14], [14, 0]]);
    const result = finish(game);
    expect(result.status).toBe('win');
    if (result.status === 'win') expect(verifyWinningProof(game, BLACK, result.proof)).toBe(true);
  });

  it('活三转活四生成分叉证明，支持 JSON 序列化后重验', () => {
    const game = three();
    const result = finish(game);
    expect(result.status).toBe('win');
    if (result.status !== 'win') return;
    expect(result.proof.kind).toBe('fork');
    expect(verifyWinningProof(game, BLACK, JSON.parse(JSON.stringify(result.proof)))).toBe(true);
  });

  it('四三强制应手链生成证明，不止检测一步活四', () => {
    const game = buildAlternating(
      [[3, 6], [4, 6], [5, 6], [6, 7], [6, 8]],
      [[2, 6], [0, 0], [0, 2], [14, 14], [14, 0]],
    );
    const result = finish(game);
    expect(result.status).toBe('win');
    if (result.status === 'win') expect(verifyWinningProof(game, BLACK, result.proof)).toBe(true);
  });

  it('双活三需要考虑全部防守应手，证明包含非冲四攻击', () => {
    const game = buildAlternating(
      [[5, 7], [6, 7], [7, 5], [7, 6]],
      [[0, 0], [0, 2], [14, 14], [14, 12]],
    );
    const result = finish(game, 3, 3000);
    expect(result.status).toBe('win');
    if (result.status !== 'win') return;
    expect(result.proof.kind).toBe('branch');
    expect(verifyWinningProof(game, BLACK, result.proof)).toBe(true);
  });

  it('对手可以先成五时，拒绝虚假的活四证明', () => {
    const game = buildAlternating(
      [[4, 7], [5, 7], [6, 7], [14, 14]],
      [[4, 9], [5, 9], [6, 9], [7, 9]],
    );
    expect(verifyWinningProof(game, BLACK, { kind: 'fork', at: 7 * 15 + 7 })).toBe(false);
  });

  it('未证明、预算耗尽、终局、轮次不符和坏输入不声称必胜', () => {
    expect(finish(create(), 3, 1).status).toBe('unknown');
    expect(finish(three(), 0).status).toBe('unknown');
    expect(finish({ ...three(), over: true }).status).toBe('unknown');
    expect(createProofSession(three(), WHITE).result().status).toBe('unknown');
    expect(finish({ ...create(), board: [] }).status).toBe('unknown');
    expect(verifyWinningProof(create(), BLACK, null)).toBe(false);
    expect(verifyWinningProof(create(), BLACK, { kind: 'five', at: 225 })).toBe(false);
  });

  it('缩小分片不改变证明，输入不被修改', () => {
    const game = three();
    const before = JSON.stringify(game);
    let clock = 0;
    const session = createProofSession(game, BLACK, { now: () => ++clock, timeBudgetMs: 10000 });
    let slices = 0;
    while (session.step(1)) slices += 1;
    expect(slices).toBeGreaterThan(0);
    expect(session.result()).toEqual(finish(game));
    expect(JSON.stringify(game)).toBe(before);
  });

  it('时间耗尽或取消返回未知，并能安全重复调用', () => {
    let clock = 0;
    const session = createProofSession(three(), BLACK, { now: () => ++clock, timeBudgetMs: 0 });
    expect(session.step()).toBe(false);
    expect(session.result()).toMatchObject({ status: 'unknown', reason: 'time' });
    const cancelled = createProofSession(three(), BLACK);
    cancelled.abort();
    cancelled.abort();
    expect(cancelled.step()).toBe(false);
    expect(cancelled.result()).toMatchObject({ status: 'unknown', reason: 'aborted' });
  });

  it.each([
    { maxNodes: NaN }, { maxNodes: Infinity }, { maxNodes: -1 },
    { maxAttacks: 1.5 }, { maxAttacks: -1 }, { timeBudgetMs: Infinity },
  ])('非法求解预算不启动搜索 %j', (options) => {
    const session = createProofSession(three(), BLACK, options);
    expect(session.step()).toBe(false);
    expect(session.result()).toEqual({ status: 'unknown', reason: 'invalid', nodes: 0 });
  });

  it('拒绝被篡改、缺防守分支、循环和伪造成五的证明', () => {
    expect(verifyWinningProof(three(), BLACK, { kind: 'five', at: 7 * 15 + 7 })).toBe(false);
    expect(verifyWinningProof(three(), BLACK, { kind: 'fork', at: 0 })).toBe(false);
    expect(verifyWinningProof(three(), BLACK, { kind: 'branch', at: 7 * 15 + 7, replies: [] })).toBe(false);
    const cyclic: { kind: string; at: number; reply: number; next?: unknown } = { kind: 'force', at: 112, reply: 113 };
    cyclic.next = cyclic;
    expect(verifyWinningProof(three(), BLACK, cyclic)).toBe(false);
  });
});
