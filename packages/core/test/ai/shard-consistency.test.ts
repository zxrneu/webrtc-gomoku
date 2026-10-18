/**
 * 分片一致性回归（QA 独立补充）
 *
 * 背景：生产环境**一定**通过 `searchDriver` 注入 `now` 并分片调用 `step(32)`；
 * 而现有全部用例（含 20 题战术基准集）都用 `{ difficulty, maxNodes }` 的
 * **不分片**模式跑，因此「分片后落点变差」这条路径没有任何测试覆盖。
 *
 * 下面两条断言写的是**正确行为**（分片只是执行方式，不得改变棋力），
 * 当前实现会红——`search.ts` 在分片边界上丢弃了未算完的根候选，
 * 却仍然提交该层结果，于是 AI 会走出「自己算出来是将死、却放弃了唯一解」的着法。
 */

import { describe, expect, it } from 'vitest';
import { BLACK, applyMove, createSearchSession, type GameState, type Point } from '../../src/index';
import { buildAlternating, cloneGame } from './helpers';

/**
 * 实战中真实出现的漏防局面（easy 档执白时就是这样赢的）：
 * 白在 x=8 形成 y=6,7,8 的活三，黑该走。
 * 唯一正确的应手是堵两端之一：(8,5) 或 (8,9)。
 */
function openThreePosition(): GameState {
  return buildAlternating(
    [
      [7, 7],
      [9, 7],
      [6, 8],
    ],
    [
      [8, 8],
      [8, 7],
      [8, 6],
    ],
  );
}

/**
 * 生产分片模式：注入单调递增的假时间源 + 32ms 片（与 searchDriver 默认值一致）。
 * 节点预算压到 20000 只是为了控制单测耗时（生产档为 60000），缺陷性质完全一致：
 * 两者都是「某一层的根候选被分片边界打断 → 被丢弃 → 该层仍被提交」。
 */
function searchSharded(g: GameState, sliceMs: number): { move: Point | null; score: number; depth: number; nodes: number } {
  let clock = 0;
  const now = (): number => {
    clock += 1;
    return clock;
  };
  const session = createSearchSession(g, BLACK, { difficulty: 'hard', now, maxNodes: 20000 });
  let guard = 0;
  while (session.step(sliceMs)) {
    guard += 1;
    if (guard > 100000) break;
  }
  const stats = session.stats();
  return { move: session.result(), score: stats.bestScore, depth: stats.depth, nodes: stats.nodes };
}

/** 不分片模式：不注入 now，纯节点预算（现有基准集的跑法） */
function searchUnsharded(g: GameState): Point | null {
  const session = createSearchSession(g, BLACK, { difficulty: 'hard', maxNodes: 20000 });
  let guard = 0;
  while (session.step()) {
    guard += 1;
    if (guard > 100000) break;
  }
  return session.result();
}

function blocksOpenThree(move: Point | null): boolean {
  if (move === null) return false;
  return move[0] === 8 && (move[1] === 5 || move[1] === 9);
}

describe('分片搜索必须与不分片搜索棋力一致（架构 §9 R2）', () => {
  it('对照组：不分片时能正确堵活三（证明评估/搜索知识本身没问题）', () => {
    expect(blocksOpenThree(searchUnsharded(openThreePosition()))).toBe(true);
  });

  it('[源码 Bug] 生产分片模式（slice=32 + 注入 now）同样必须堵活三', () => {
    const result = searchSharded(openThreePosition(), 32);

    expect(
      blocksOpenThree(result.move),
      `分片搜索落点 ${JSON.stringify(result.move)} 未堵白方活三（8,5）/（8,9）；` +
        `深度=${result.depth} 节点=${result.nodes} 根节点分=${result.score}` +
        `（分数 -9_999_996 表示引擎自己算出「已被将死」，却放弃了唯一能活的着法）`,
    ).toBe(true);
  });

  it('[源码 Bug] 分片落点必须与不分片落点一致（同档位、同节点预算）', () => {
    const g = openThreePosition();
    const sharded = searchSharded(g, 32).move;
    const unsharded = searchUnsharded(cloneGame(g));

    expect(sharded, `分片落点 ${JSON.stringify(sharded)} 与不分片落点 ${JSON.stringify(unsharded)} 不一致`).toEqual(
      unsharded,
    );
  });
});
