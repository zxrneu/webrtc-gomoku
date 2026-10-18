import { describe, expect, it } from 'vitest';
import {
  BLACK, WHITE, applyMove, create, createProofSession, verifyWinningProof,
  type GameState, type WinningProof,
} from '../../src/index';
import { buildAlternating, cloneGame } from './helpers';

function simpleFivePosition(): GameState {
  return buildAlternating(
    [[7, 7], [8, 7], [9, 7], [10, 7]],
    [[0, 0], [0, 2], [0, 4], [0, 6]],
  );
}

function vcfPosition(): GameState {
  // 黑棋有 3 步连杀（连续冲四）
  return buildAlternating(
    [[6, 6], [7, 7], [8, 8], [9, 6], [9, 8]],
    [[0, 0], [0, 2], [0, 4], [0, 6], [0, 8]],
  );
}

function branchingThreePosition(): GameState {
  // 经典双活三，防守方有多个合法应手，要求覆盖全部分支
  return buildAlternating(
    [[5, 7], [6, 7], [7, 5], [7, 6]],
    [[0, 0], [0, 14], [14, 0], [14, 14]],
  );
}

function attackBranchingPosition(): GameState {
  // 黑棋在右上角有双活三诱饵 [11,2]（周围空间充裕，分值 300,000，引诱 DFS 陷入遍历防守分支耗尽预算）；
  // 黑棋在左侧有冲四杀 [5,5]（单冲四分值 100,000）-> 白应 [6,5] -> [5,6] 冲四 -> 白应 [5,4] -> [5,9] 成五；
  // PNS 凭借威胁优先级优先探索冲四并迅速证明，而 DFS 被双活三高分误导耗尽节点。
  return buildAlternating(
    [
      // 诱饵双活三构成子（中心 [11, 2]）
      [9, 2], [10, 2],
      [11, 3], [11, 4],
      // 冲四杀构成子
      [2, 5], [3, 5], [4, 5],
      [5, 7], [5, 8],
      [2, 9], [3, 9], [4, 9],
    ],
    [
      // 堵住冲四一侧，保持单冲四
      [1, 5],
      [1, 9],
      [5, 4],  // 堵住上方，保证 [5,5] 不与列5构成双威胁
      [5, 10], // 堵住下方，保证最终成五点 [5,9] 有效
      // 散布在边缘的无威胁白子，保持手权平衡（各 12 子）
      [0, 0], [0, 14], [14, 0], [14, 14],
      [0, 7], [14, 7], [7, 0], [7, 14],
    ],
  );
}

describe('证明数搜索（PNS）算法与证明边界', () => {
  it('一步成五能直接证明并生成 five 证书', () => {
    const game = simpleFivePosition();
    const session = createProofSession(game, BLACK, { algorithm: 'pn', maxNodes: 100 });
    while (session.step()) { /* 跑完 */ }
    const res = session.result();
    expect(res.status).toBe('win');
    if (res.status === 'win') {
      expect(res.proof.kind).toBe('five');
      expect(verifyWinningProof(game, BLACK, res.proof)).toBe(true);
    }
  });

  it('连续冲四通过强制压缩生成 force 链并通过独立验证', () => {
    const game = vcfPosition();
    const session = createProofSession(game, BLACK, {
      algorithm: 'pn', maxAttacks: 6, maxNodes: 3000, mode: 'fours',
    });
    while (session.step()) { /* 跑完 */ }
    const res = session.result();
    expect(res.status).toBe('win');
    if (res.status === 'win') {
      expect(verifyWinningProof(game, BLACK, res.proof)).toBe(true);
    }
  });

  it('非强制防守分支覆盖全盘全部合法应手，证书经独立检查器验证', () => {
    const game = branchingThreePosition();
    const session = createProofSession(game, BLACK, {
      algorithm: 'pn', maxAttacks: 6, maxNodes: 5000, mode: 'threats',
    });
    while (session.step()) { /* 跑完 */ }
    const res = session.result();
    expect(res.status).toBe('win');
    if (res.status === 'win') {
      expect(verifyWinningProof(game, BLACK, res.proof)).toBe(true);
    }
  });

  it('预算不足、深度受限或超时均返回 unknown，绝不解释为必败', () => {
    const game = branchingThreePosition();
    // 限制 1 个节点必耗尽
    const nodeSession = createProofSession(game, BLACK, { algorithm: 'pn', maxNodes: 1 });
    while (nodeSession.step()) { /* 跑完 */ }
    expect(nodeSession.result().status).toBe('unknown');
    expect((nodeSession.result() as any).reason).toBe('nodes');

    // 限制 0 次进攻必深度不足
    const depthSession = createProofSession(game, BLACK, { algorithm: 'pn', maxAttacks: 0 });
    while (depthSession.step()) { /* 跑完 */ }
    expect(depthSession.result().status).toBe('unknown');
    expect((depthSession.result() as any).reason).toBe('depth');

    // 取消
    const abortSession = createProofSession(game, BLACK, { algorithm: 'pn', maxNodes: 10000 });
    abortSession.abort();
    expect(abortSession.result().status).toBe('unknown');
    expect((abortSession.result() as any).reason).toBe('aborted');
  });

  it('相同局面多次运行，节点数和证书完全确定且不修改输入棋局', () => {
    const game = branchingThreePosition();
    const before = cloneGame(game);
    const run = () => {
      const s = createProofSession(game, BLACK, { algorithm: 'pn', maxNodes: 2000 });
      while (s.step()) { /* 跑完 */ }
      return s.result();
    };
    const r1 = run();
    const r2 = run();
    expect(r1).toEqual(r2);
    expect(game).toEqual(before);
  });

  it('分片搜索结果与不分片完全一致', () => {
    const game = vcfPosition();
    const directSession = createProofSession(game, BLACK, { algorithm: 'pn', maxNodes: 3000, mode: 'fours' });
    while (directSession.step(10000)) { /* 一步到位 */ }

    let clock = 0;
    const shardedSession = createProofSession(game, BLACK, {
      algorithm: 'pn', maxNodes: 3000, mode: 'fours', timeBudgetMs: 100000, now: () => ++clock,
    });
    let slices = 0;
    while (shardedSession.step(1)) slices += 1;

    expect(slices).toBeGreaterThan(0);
    expect(shardedSession.result()).toEqual(directSession.result());
  });

  it('固定进攻局面：在相同节点预算下 PNS 优于 DFS（PNS 证明成功而 DFS 耗尽）', () => {
    const game = attackBranchingPosition();
    const budget = 40; // 较紧凑的节点预算

    // DFS 在该预算下由于先深度搜索干扰分支而耗尽
    const dfsSession = createProofSession(game, BLACK, {
      algorithm: 'dfs', maxNodes: budget, maxAttacks: 5, mode: 'threats',
    });
    while (dfsSession.step()) { /* 跑完 */ }
    expect(dfsSession.result().status).toBe('unknown');

    // PNS 在相同预算下能根据证明数发现更优路径并胜出
    const pnSession = createProofSession(game, BLACK, {
      algorithm: 'pn', maxNodes: budget, maxAttacks: 5, mode: 'threats',
    });
    while (pnSession.step()) { /* 跑完 */ }
    const pnRes = pnSession.result();
    expect(pnRes.status).toBe('win');
    if (pnRes.status === 'win') {
      expect(verifyWinningProof(game, BLACK, pnRes.proof)).toBe(true);
    }
  });

  it('固定防守局面：在相同节点预算下新算法（PNS+活三）优于旧算法（检出反杀而旧算法未检出）', () => {
    // 白棋在天元附近有双活三杀（非连续冲四，依赖活三分支）。
    // 黑棋走坏手后，旧算法（mode: 'fours'）无法发现该反杀（返回 unknown）；
    // 新算法 PNS（mode: 'threats'）在相同节点预算（300节点）内能成功证明白棋必胜并生成有效证书。
    const game = buildAlternating(
      [
        [0, 0], [0, 14], [14, 0], [14, 14],
        [12, 12], // 黑棋走的坏手
      ],
      [
        // 白棋双活三：[7,7] 为交点
        [5, 7], [6, 7],
        [7, 5], [7, 6],
      ],
    );
    const budget = 300; // 相同节点预算

    // 旧算法（仅冲四，未包含活三）无法发现反杀
    const oldSession = createProofSession(game, WHITE, {
      algorithm: 'dfs', mode: 'fours', maxNodes: budget, maxAttacks: 6,
    });
    while (oldSession.step()) { /* 跑完 */ }
    expect(oldSession.result().status).toBe('unknown');

    // 新算法（PNS+活三）在相同预算内证明白棋必胜
    const pnsSession = createProofSession(game, WHITE, {
      algorithm: 'pn', mode: 'threats', maxNodes: budget, maxAttacks: 6,
    });
    while (pnsSession.step()) { /* 跑完 */ }
    const pnsRes = pnsSession.result();
    expect(pnsRes.status).toBe('win');
    if (pnsRes.status === 'win') {
      expect(verifyWinningProof(game, WHITE, pnsRes.proof)).toBe(true);
    }
  });
});
