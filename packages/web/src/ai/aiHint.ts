/** 将引擎识别的局部棋形翻译成玩家能核对的理由，不推断未证明的必胜。 */
import {
  idxOf, otherColor, patternAt, findFivePoints,
  createPositionState, type GameState, type PlayerColor, type Point, type PatternType,
} from '@webrtc-gomoku/core';

export interface AiHint {
  readonly point: Point;
  readonly reasons: readonly string[];
}

const DIRECTIONS = ['横向', '纵向', '左上至右下斜线', '左下至右上斜线'] as const;
const DEFENSE: Partial<Record<PatternType, string>> = {
  OPEN_FOUR: '活四', FOUR: '冲四', OPEN_THREE: '活三',
};
const UNSAFE_BENEFITS: Partial<Record<PatternType, string>> = {
  OPEN_FOUR: '形成活四，但对手可先成五，不能靠这条进攻解除眼前危机。',
  FOUR: '形成冲四，但对手可先成五，不能靠这条进攻解除眼前危机。',
};
const BENEFITS: Partial<Record<PatternType, string>> = {
  FIVE: '连成五子，这一步可以直接获胜。',
  OPEN_FOUR: '形成活四，两端都有成五点，对手只堵一端仍挡不住另一端。',
  FOUR: '形成冲四，留下下一手成五的点，迫使对手优先防守。',
  OPEN_THREE: '形成活三，两端都有发展空间，可以继续争取活四。',
  SLEEP_THREE: '形成眠三，延续进攻，但空间受限，还需要后续配合。',
  OPEN_TWO: '形成活二，连接己方棋子，为后续活三保留空间。',
};

export function explainHint(game: GameState, point: Point, color: PlayerColor): AiHint | null {
  const [x, y] = point;
  if (game.over || !point.every(Number.isInteger) || game.board[y]?.[x] !== 0) return null;
  const cells = Int8Array.from(game.board.flat());
  const at = idxOf(x, y);
  const own = DIRECTIONS.map((_, dir) => patternAt(cells, at, dir, color));
  if (own.includes('FIVE')) return {
    point,
    reasons: DIRECTIONS.flatMap((name, i) => own[i] === 'FIVE' ? [`${name}：${BENEFITS.FIVE}`] : []),
  };
  const opponent = otherColor(color);
  const threats = findFivePoints(createPositionState(cells), opponent);
  const hasRemainingThreat = threats.some((cell) => cell !== at);
  const reasons = own.flatMap((pattern, dir) => {
    const benefit = (hasRemainingThreat ? UNSAFE_BENEFITS[pattern] : undefined) ?? BENEFITS[pattern];
    return benefit ? [`${DIRECTIONS[dir]}：${benefit}`] : [];
  });
  if (threats.length > 0) {
    const blocks = threats.includes(at);
    reasons.unshift(blocks
      ? '先防守：对手下一手可以在这里连成五子，抢占这个点可挡住这条进攻。'
      : '注意：对手仍有下一手成五的点，这步没有消除直接败局风险。');
    if (blocks && threats.length > 1) reasons.push('但对手仍有其他成五点，只挡这里无法化解全部威胁。');
  }
  reasons.push(...DIRECTIONS.flatMap((name, dir) => {
    const threat = DEFENSE[patternAt(cells, at, dir, opponent)];
    return threat ? [`${name}：抢占这个点，避免对手在这里形成${threat}，压缩其进攻空间。`] : [];
  }));
  if (reasons.length === 0) reasons.push(x === 7 && y === 7 && cells.every((cell) => cell === 0)
    ? '占据棋盘中心，向横、竖和两条斜线四个方向发展，保留更多连接空间。'
    : '这步未形成直接威胁，是搜索后的布局建议；可结合附近棋子的连接与后续应手理解。');
  return { point, reasons };
}
