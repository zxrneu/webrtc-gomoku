import { Fragment, useEffect, useState } from 'react';
import { BLACK, WHITE } from '@webrtc-gomoku/core';
import styles from './PlayerTrays.module.css';
import { PlayerName } from './PlayerName';
import type { Move, PlayerColor } from '@webrtc-gomoku/core';
import type { TransportInfo } from '@webrtc-gomoku/shared';

export interface PlayerTraysProps {
  black: { name: string; tag: string };
  white: { name: string; tag: string };
  myColor: PlayerColor;
  turn: PlayerColor | null;
  moves: Move[];
  connected: boolean;
  over: boolean;
  transport: TransportInfo | null;
  actions: { onPick: () => void; onSwap: () => void; onName?: (name: string) => void };
  variant?: 'online' | 'ai';
}

/** 黑白棋盒与玩家信息；拿棋只提供操作反馈，落子仍由棋盘统一处理。 */
export function PlayerTrays(props: PlayerTraysProps) {
  const { black, white, myColor, turn, moves, connected, over, transport, actions, variant } = props;
  const [picked, setPicked] = useState(false);
  useEffect(() => setPicked(false), [moves, turn, myColor, connected]);
  const local = variant === 'ai';
  const swapLabel = local ? '切换执子并重新开局' : connected ? `当前执${myColor === BLACK ? '黑' : '白'}，申请换边` : `切换为执${myColor === BLACK ? '白' : '黑'}`;
  const last = moves[moves.length - 1];
  return <div id="player-trays" className={styles.trays}>
    {([BLACK, WHITE] as const).map(color => {
      const isBlack = color === BLACK;
      const player = isBlack ? black : white;
      const active = connected && !over && turn === color;
      const canPick = active && color === myColor;
      return <Fragment key={color}><div id={isBlack ? 'player-black' : 'player-white'}
        className={`${styles.player} ${active ? styles.active : ''}`} data-turn={active}>
        <button type="button" className={`${styles.bowl} ${isBlack ? styles.black : styles.white}`}
          aria-label={isBlack ? '拿起黑棋' : '拿起白棋'} disabled={!canPick}
          aria-pressed={canPick && picked} onClick={() => { if (canPick) { setPicked(true); actions.onPick(); } }}>
          <span aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</span>
        </button>
        <div className={styles.info}>
          <PlayerName id={isBlack ? 'black-name' : 'white-name'} name={player.name || (isBlack ? '黑方' : '白方')}
            onSave={color === myColor ? actions.onName : undefined} />
          <small id={isBlack ? 'black-tag' : 'white-tag'}>{player.tag}</small>
          <span className={styles.prompt} aria-live="polite">{!connected ? '等待入座' : over ? '对局结束'
            : canPick ? picked ? '已拿起，点棋盘' : '拿棋落子'
            : active ? local ? 'AI 思考中…' : '正在落子…' : '等待回合'}</span>
        </div>
      </div>
      {isBlack && <button id="toggle-color-btn" type="button" className={styles.swap}
        aria-label={swapLabel} title={swapLabel} disabled={over && !local} onClick={actions.onSwap}>
        <span aria-hidden="true">⇄</span>
      </button>}</Fragment>;
    })}
    <div className={styles.meta}>
      <span>第 <b id="move-count">{moves.length}</b> 手</span>
      <span>上一手 <b id="last-move">{last ? `${'ABCDEFGHIJKLMNO'[last.x]}${15 - last.y}` : '—'}</b></span>
      <span id="game-state">{!connected ? '等待棋友' : over ? '已结束' : '对弈中'}</span>
      {connected && transport && <span id="transport-line" title={transport.summary}>
        <i id="transport-dot" /><span id="transport-label">{transport.summary}</span>
      </span>}
    </div>
  </div>;
}
