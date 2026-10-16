import React from 'react';
import type { Move, PlayerColor } from '@webrtc-gomoku/core';
import type { TransportInfo } from '@webrtc-gomoku/shared';
import styles from './GameStatus.module.css';

interface GameStatusProps {
  blackName: string;
  whiteName: string;
  blackTag: string;
  whiteTag: string;
  myColor: PlayerColor;
  moves: Move[];
  over: boolean;
  connected: boolean;
  transport: TransportInfo | null;
}

const COLS = 'ABCDEFGHIJKLMNO';

export const GameStatus: React.FC<GameStatusProps> = ({
  blackName,
  whiteName,
  blackTag,
  whiteTag,
  moves,
  over,
  connected,
  transport,
}) => {
  const lastMoveText =
    moves.length > 0
      ? `${COLS[moves[moves.length - 1]!.x]}${15 - moves[moves.length - 1]!.y}`
      : '-';

  const gameStateText = !connected ? '未开始' : over ? '已结束' : '对局中';

  return (
    <div id="game-card" className={`${styles.gameCard} card`}>
      <div className={`${styles.players} players`}>
        <div id="player-black" className={`${styles.player} player`}>
          <span className={`${styles.stoneDot} ${styles.stoneBlack} stone-dot black`} />
          <div className={styles.playerInfo}>
            <b id="black-name">{blackName || '黑方'}</b>
            <small id="black-tag">{blackTag}</small>
          </div>
        </div>
        <div className={`${styles.vs} vs`}>VS</div>
        <div id="player-white" className={`${styles.player} player`}>
          <span className={`${styles.stoneDot} ${styles.stoneWhite} stone-dot white`} />
          <div className={styles.playerInfo}>
            <b id="white-name">{whiteName || '白方'}</b>
            <small id="white-tag">{whiteTag}</small>
          </div>
        </div>
      </div>

      <div className={`${styles.stats} stats`}>
        <div className={styles.statItem}>
          <small>手数</small>
          <b id="move-count">{moves.length}</b>
        </div>
        <div className={styles.statItem}>
          <small>最后一手</small>
          <b id="last-move">{lastMoveText}</b>
        </div>
        <div className={styles.statItem}>
          <small>状态</small>
          <b id="game-state">{gameStateText}</b>
        </div>
      </div>

      <div
        id="transport-line"
        className={`${styles.transport} transport ${connected && transport ? '' : 'hidden'}`}
        style={{ display: connected && transport ? 'flex' : 'none' }}
      >
        <span id="transport-dot" className={`${styles.transportDot} transport-dot`} />
        <div>
          <b id="transport-label">{transport?.summary || 'WebRTC 直连'}</b>
          <small id="transport-detail" />
        </div>
      </div>
    </div>
  );
};
