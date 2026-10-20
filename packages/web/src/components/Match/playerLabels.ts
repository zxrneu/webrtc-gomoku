import type { Difficulty, PlayerColor } from '@webrtc-gomoku/core';
import type { GameMode } from '../../types';
import { BLACK } from '@webrtc-gomoku/core';
import { DIFFICULTY_LABELS } from '../../ai/aiLabels';

interface PlayerLabelInput {
  mode: GameMode;
  myColor: PlayerColor;
  isHost: boolean;
  myName: string;
  peerName: string;
  difficulty: Difficulty;
}

/** 按执子分配昵称，身份始终跟随本人而不跟随棋子颜色。 */
export function playerLabels({ mode, myColor, isHost, myName, peerName, difficulty }: PlayerLabelInput) {
  const isBlack = myColor === BLACK;
  if (mode === 'ai') return {
    blackName: isBlack ? '我' : `AI（${DIFFICULTY_LABELS[difficulty]}）`,
    whiteName: isBlack ? `AI（${DIFFICULTY_LABELS[difficulty]}）` : '我',
    blackTag: isBlack ? '先行' : 'AI', whiteTag: isBlack ? 'AI' : '后手',
  };
  const mine = myName ? `${myName} (我)` : isHost ? '房主 (我)' : '玩家 (我)';
  const peer = peerName || (isHost ? '加入方' : '房主');
  return {
    blackName: isBlack ? mine : peer, whiteName: isBlack ? peer : mine,
    blackTag: (isBlack ? isHost : !isHost) ? '房主 (先行)' : '加入方 (先行)',
    whiteTag: (isBlack ? !isHost : isHost) ? '房主' : '加入方',
  };
}
