/**
 * 证明数搜索（Proof-Number Search, PNS）。
 * 攻击方为 OR 节点，防守方为 AND 节点，按证明数选择最易证明的路径展开。
 * 防守节点覆盖全部合法应手，仅在强制堵四等规则认可时压缩分支。
 */
import { AI_CELLS, oppositeOf } from './types';
import type { PositionState } from './evaluate';
import { getHypoPointScore, placeStone, removeStone } from './evaluate';
import { findFivePoints } from './movegen';
import type { WinningProof } from './proof';
import { winsAt } from './proofRules';
import { orderAttackCandidates, type Threat, analyzeThreats, threatDependsOn } from './dependency';
import type { ThreatContext } from './threatSearch';

const INF = 1_000_000_000;

/** 防守候选排序与去重静态缓冲（长度 225，零堆分配） */
const scratchDefenseAt = new Int16Array(AI_CELLS);
const scratchDefensePri = new Int32Array(AI_CELLS);

interface OrNode {
  type: 'or';
  attacks: number;
  pn: number;
  dn: number;
  expanded: boolean;
  children: AndNode[];
  parentThreat?: Threat;
}

interface AndNode {
  type: 'and';
  at: number;
  priority: number;
  attacks: number;
  pn: number;
  dn: number;
  isTerminal: boolean;
  proof?: WinningProof;
  forcedReply?: number;
  orChild?: OrNode;
  replies?: { at: number; priority: number; orChild: OrNode }[];
  threat?: Threat;
}

function updateOrNode(node: OrNode): void {
  if (node.children.length === 0) {
    if (node.expanded) {
      node.pn = INF;
      node.dn = 0;
    }
    return;
  }

  let minPn = INF;
  let sumDn = 0;
  for (const c of node.children) {
    if (c.pn === 0) {
      node.pn = 0;
      node.dn = INF;
      return;
    }
    if (c.pn < minPn) minPn = c.pn;
    sumDn += c.dn;
    if (sumDn > INF) sumDn = INF;
  }

  node.pn = minPn;
  node.dn = sumDn;
}

function updateAndNode(node: AndNode): void {
  if (node.isTerminal) return;
  if (node.forcedReply !== undefined && node.orChild) {
    node.pn = node.orChild.pn;
    node.dn = node.orChild.dn;
    if (node.pn === 0 || node.dn === 0) node.isTerminal = true;
    return;
  }
  if (node.replies !== undefined) {
    let sumPn = 0;
    let minDn = INF;
    for (const r of node.replies) {
      if (r.orChild.dn === 0) {
        node.pn = INF;
        node.dn = 0;
        node.isTerminal = true;
        return;
      }
      sumPn += r.orChild.pn;
      if (sumPn > INF) sumPn = INF;
      if (r.orChild.dn < minDn) minDn = r.orChild.dn;
    }
    node.pn = sumPn;
    node.dn = minDn;
    if (node.pn === 0 || node.dn === 0) node.isTerminal = true;
  }
}

function evaluateAndNode(
  at: number,
  attacks: number,
  st: PositionState,
  ctx: ThreatContext,
  parentThreat?: Threat,
): AndNode {
  // 落子前先分析该点形成的威胁（此时 st.cells[at] === 0）
  let threat: Threat | undefined;
  if (ctx.mode !== 'fours') {
    const threats = analyzeThreats(st.cells, at, ctx.attacker);
    threat = threats[0];
  }

  placeStone(st, at, ctx.attacker);
  try {
    // 1. 进攻方直接成五
    if (winsAt(st.cells, at, ctx.attacker)) {
      return { type: 'and', at, priority: 50000, attacks, pn: 0, dn: INF, isTerminal: true, proof: { kind: 'five', at } };
    }

    const defender = oppositeOf(ctx.attacker);

    // 2. 防守方已有立即成五威胁且未被阻止
    if (findFivePoints(st, defender).length > 0) {
      return { type: 'and', at, priority: 0, attacks, pn: INF, dn: 0, isTerminal: true };
    }

    // 3. 进攻方是否形成复合绝杀（双四 / 两个立即成五点）
    const myWins = findFivePoints(st, ctx.attacker);
    if (myWins.length >= 2) {
      return { type: 'and', at, priority: 40000, attacks, pn: 0, dn: INF, isTerminal: true, proof: { kind: 'fork', at } };
    }

    // 最后一手进攻若未成五或双四，则无法在后续进攻中取胜
    if (attacks <= 1) {
      return { type: 'and', at, priority: 0, attacks, pn: INF, dn: 0, isTerminal: true };
    }

    // 4. 强制堵四分支压缩
    if (myWins.length === 1) {
      const reply = myWins[0]!;
      placeStone(st, reply, defender);
      const defWins = winsAt(st.cells, reply, defender);
      removeStone(st, reply);
      if (defWins) {
        return { type: 'and', at, priority: 0, attacks, pn: INF, dn: 0, isTerminal: true };
      }
      if (!threat) {
        threat = {
          kind: 'four',
          gain: at,
          cost: [reply],
          rest: [reply],
          stones: [],
        };
      }
      let priority = 30000;
      if (parentThreat && (parentThreat.cost.includes(at) || threatDependsOn(parentThreat, threat))) {
        priority = 35000;
      }
      const orChild: OrNode = {
        type: 'or',
        attacks: attacks - 1,
        pn: 1,
        dn: 1,
        expanded: false,
        children: [],
        parentThreat: threat,
      };
      return {
        type: 'and',
        at,
        priority,
        attacks,
        pn: 1,
        dn: 1,
        isTerminal: false,
        forcedReply: reply,
        orChild,
        threat,
      };
    }

    // 5. 非冲四在 fours 模式下直接判负
    if (ctx.mode === 'fours') {
      return { type: 'and', at, priority: 0, attacks, pn: INF, dn: 0, isTerminal: true };
    }

    // 非强制防守必须覆盖全部合法空点；威胁点分仅用于排序，不能省略应手。
    let candidateCount = 0;
    for (let cell = 0; cell < AI_CELLS; cell += 1) {
      if (st.cells[cell] === 0) scratchDefenseAt[candidateCount++] = cell;
    }

    if (candidateCount === 0) {
      return { type: 'and', at, priority: 0, attacks, pn: INF, dn: 0, isTerminal: true };
    }

    // 6.3 优先级计算：直接堵三/冲四点权值最高，其次双方点分之和
    for (let i = 0; i < candidateCount; i += 1) {
      const r = scratchDefenseAt[i]!;
      let rPriority = getHypoPointScore(st, r, defender) + getHypoPointScore(st, r, ctx.attacker);
      if (threat?.cost.includes(r)) {
        rPriority += 100_000_000;
      } else if (threat?.rest.includes(r)) {
        rPriority += 10_000_000;
      }
      scratchDefensePri[i] = rPriority;
    }

    // 6.4 原地插入排序（降序优先级，升序 idx 稳定 tie-break）
    for (let i = 1; i < candidateCount; i += 1) {
      const curAt = scratchDefenseAt[i]!;
      const curPri = scratchDefensePri[i]!;
      let j = i - 1;
      while (j >= 0) {
        const prevPri = scratchDefensePri[j]!;
        const prevAt = scratchDefenseAt[j]!;
        if (prevPri < curPri || (prevPri === curPri && prevAt > curAt)) {
          scratchDefenseAt[j + 1] = prevAt;
          scratchDefensePri[j + 1] = prevPri;
          j -= 1;
        } else {
          break;
        }
      }
      scratchDefenseAt[j + 1] = curAt;
      scratchDefensePri[j + 1] = curPri;
    }

    const branchCount = candidateCount;
    const replies = new Array<{ at: number; priority: number; orChild: OrNode }>(branchCount);
    for (let i = 0; i < branchCount; i += 1) {
      const rAt = scratchDefenseAt[i]!;
      const rPri = scratchDefensePri[i]!;
      replies[i] = {
        at: rAt,
        priority: rPri,
        orChild: {
          type: 'or' as const,
          attacks: attacks - 1,
          pn: 1,
          dn: 1,
          expanded: false,
          children: [],
          parentThreat: threat,
        },
      };
    }

    let priority = 20000;
    if (parentThreat && threat && (parentThreat.cost.includes(at) || threatDependsOn(parentThreat, threat))) {
      priority = 25000;
    }

    return {
      type: 'and',
      at,
      priority,
      attacks,
      pn: replies.length,
      dn: 1,
      isTerminal: false,
      replies,
      threat,
    };
  } finally {
    removeStone(st, at);
  }
}

function* selectAndExpandOr(
  node: OrNode,
  st: PositionState,
  ctx: ThreatContext,
): Generator<void, void, void> {
  if (node.pn === 0 || node.dn === 0) return;

  if (!node.expanded) {
    // 展开 OR 节点
    const wins = findFivePoints(st, ctx.attacker);
    if (wins.length > 0) {
      const winAt = wins[0]!;
      node.children = [{
        type: 'and',
        at: winAt,
        priority: 50000,
        attacks: node.attacks,
        pn: 0,
        dn: INF,
        isTerminal: true,
        proof: { kind: 'five', at: winAt },
      }];
      node.expanded = true;
      node.pn = 0;
      node.dn = INF;
      return;
    }

    const oppWins = findFivePoints(st, oppositeOf(ctx.attacker));
    if (oppWins.length >= 2) {
      node.pn = INF;
      node.dn = 0;
      node.expanded = true;
      return;
    }

    if (node.attacks <= 0) {
      node.pn = INF;
      node.dn = 0;
      node.expanded = true;
      return;
    }

    const candidates = orderAttackCandidates(st, ctx.attacker, ctx.mode, node.parentThreat);
    if (candidates.length === 0) {
      node.pn = INF;
      node.dn = 0;
      node.expanded = true;
      return;
    }

    node.expanded = true;
    for (const at of candidates) {
      if (ctx.nodes >= ctx.maxNodes) {
        ctx.exhausted = true;
        break;
      }
      ctx.nodes += 1;
      const andChild = evaluateAndNode(at, node.attacks, st, ctx, node.parentThreat);
      node.children.push(andChild);
      if (andChild.pn === 0) break; // 提前命中直接获胜
    }
    updateOrNode(node);
    return;
  }

  // 递归向下选择证明数最小的 OR 分支，相同证明数按优先级降序、坐标升序稳定选择
  let bestChild: AndNode | undefined;
  let minPn = INF;
  let bestPriority = -1;
  for (const c of node.children) {
    if (c.pn > 0 && c.pn < INF) {
      if (c.pn < minPn) {
        minPn = c.pn;
        bestPriority = c.priority;
        bestChild = c;
      } else if (c.pn === minPn && c.priority > bestPriority) {
        bestPriority = c.priority;
        bestChild = c;
      }
    }
  }
  if (!bestChild) {
    updateOrNode(node);
    return;
  }

  placeStone(st, bestChild.at, ctx.attacker);
  try {
    yield* selectAndExpandAnd(bestChild, st, ctx);
  } finally {
    removeStone(st, bestChild.at);
  }
  updateOrNode(node);
}

function* selectAndExpandAnd(
  node: AndNode,
  st: PositionState,
  ctx: ThreatContext,
): Generator<void, void, void> {
  if (node.pn === 0 || node.dn === 0 || node.isTerminal) return;
  const defender = oppositeOf(ctx.attacker);

  if (node.forcedReply !== undefined && node.orChild) {
    placeStone(st, node.forcedReply, defender);
    try {
      yield* selectAndExpandOr(node.orChild, st, ctx);
    } finally {
      removeStone(st, node.forcedReply);
    }
    updateAndNode(node);
    return;
  }

  if (node.replies !== undefined) {
    let bestReply: { at: number; orChild: OrNode; priority: number } | undefined;
    let minDn = INF;
    let bestPriority = -1;
    for (const r of node.replies) {
      if (r.orChild.dn > 0) {
        if (r.orChild.dn < minDn) {
          minDn = r.orChild.dn;
          bestPriority = r.priority;
          bestReply = r;
        } else if (r.orChild.dn === minDn && r.priority > bestPriority) {
          bestPriority = r.priority;
          bestReply = r;
        }
      }
    }
    if (!bestReply) {
      updateAndNode(node);
      return;
    }

    placeStone(st, bestReply.at, defender);
    try {
      yield* selectAndExpandOr(bestReply.orChild, st, ctx);
    } finally {
      removeStone(st, bestReply.at);
    }
    updateAndNode(node);
  }
}

function buildProof(node: OrNode): WinningProof | null {
  const provedChild = node.children.find((c) => c.pn === 0);
  if (!provedChild) return null;
  if (provedChild.proof) return provedChild.proof;
  if (provedChild.forcedReply !== undefined && provedChild.orChild) {
    const nextProof = buildProof(provedChild.orChild);
    if (!nextProof) return null;
    return { kind: 'force', at: provedChild.at, reply: provedChild.forcedReply, next: nextProof };
  }
  if (provedChild.replies !== undefined) {
    const replies: { at: number; proof: WinningProof }[] = [];
    for (const r of provedChild.replies) {
      const childProof = buildProof(r.orChild);
      if (!childProof) return null;
      replies.push({ at: r.at, proof: childProof });
    }
    return { kind: 'branch', at: provedChild.at, replies };
  }
  return null;
}

export function* searchPnProof(
  st: PositionState,
  ctx: ThreatContext,
  maxAttacks: number,
): Generator<void, WinningProof | null, void> {
  ctx.nodes += 1;
  yield;
  if (maxAttacks <= 0 || ctx.exhausted) return null;
  if (ctx.nodes > ctx.maxNodes) {
    ctx.exhausted = true;
    return null;
  }

  const root: OrNode = {
    type: 'or',
    attacks: maxAttacks,
    pn: 1,
    dn: 1,
    expanded: false,
    children: [],
  };

  while (root.pn > 0 && root.dn > 0) {
    yield;
    if ((ctx.nodes & 15) === 0 && ctx.now && ctx.deadline !== undefined && ctx.now() >= ctx.deadline) {
      ctx.exhausted = true;
      return null;
    }
    if (ctx.nodes >= ctx.maxNodes) {
      ctx.exhausted = true;
      return null;
    }
    yield* selectAndExpandOr(root, st, ctx);
  }

  if (root.pn === 0) {
    return buildProof(root);
  }
  return null;
}
