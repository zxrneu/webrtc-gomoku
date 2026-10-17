import React from 'react';
import type { Move, PlayerColor } from '@webrtc-gomoku/core';
import type { TransportInfo } from '@webrtc-gomoku/shared';
import styles from './GameStatus.module.css';

/**
 * 对局状态看板入参属性接口
 */
interface GameStatusProps {
  /** 黑方玩家昵称（默认 "黑方"） */
  blackName: string;
  /** 白方玩家昵称（默认 "白方"） */
  whiteName: string;
  /** 黑方标签（如 "我 (房主)" / "对方"） */
  blackTag: string;
  /** 白方标签（如 "我 (挑战者)" / "对方"） */
  whiteTag: string;
  /** 本端玩家所分配的执子颜色（BLACK 或 WHITE） */
  myColor: PlayerColor;
  /** 历史落子记录列表，用于实时显示当前对局总手数及最后一手棋盘坐标 */
  moves: Move[];
  /** 游戏是否已结束（胜负已分或和棋） */
  over: boolean;
  /** WebRTC P2P 数据通道是否已连接就绪 */
  connected: boolean;
  /** 底层网络通道的物理传输链路信息（如 "WebRTC 直连 (host 局域网)" / "TURN 中继"） */
  transport: TransportInfo | null;
}

/** 棋盘横轴坐标字母表（A 到 O） */
const COLS = 'ABCDEFGHIJKLMNO';

/**
 * 对局状态看板组件 (GameStatus)
 * 职责：
 * 1. 呈现双方对阵卡片（黑方 VS 白方、身份标签、执子色标）
 * 2. 实时统计数据（已落子总手数、最后一手标准坐标如 "H8"、对局状态）
 * 3. 底层 WebRTC 传输链路指示器（高亮直连/打洞或中继状态）
 */
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
  // 计算最后一手棋盘落子坐标（例如 x=7, y=7 映射为 "H8"，五子棋纵轴自底向上 1~15）
  const lastMoveText =
    moves.length > 0
      ? `${COLS[moves[moves.length - 1]!.x]}${15 - moves[moves.length - 1]!.y}`
      : '-';

  // 统一推导当前游戏所处宏观阶段
  const gameStateText = !connected ? '未开始' : over ? '已结束' : '对局中';

  return (
    <div id="game-card" className={`${styles.gameCard} card`}>
      {/* 双方玩家对阵栏 (黑方 VS 白方) */}
      <div className={`${styles.players} players`}>
        {/* 黑方信息 */}
        <div id="player-black" className={`${styles.player} player`}>
          <span className={`${styles.stoneDot} ${styles.stoneBlack} stone-dot black`} />
          <div className={styles.playerInfo}>
            <b id="black-name">{blackName || '黑方'}</b>
            <small id="black-tag">{blackTag}</small>
          </div>
        </div>

        {/* VS 徽标 */}
        <div className={`${styles.vs} vs`}>VS</div>

        {/* 白方信息 */}
        <div id="player-white" className={`${styles.player} player`}>
          <span className={`${styles.stoneDot} ${styles.stoneWhite} stone-dot white`} />
          <div className={styles.playerInfo}>
            <b id="white-name">{whiteName || '白方'}</b>
            <small id="white-tag">{whiteTag}</small>
          </div>
        </div>
      </div>

      {/* 对局实时数据统计网格 */}
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

      {/* WebRTC 底层传输链路诊断信息条（连接成功后展示） */}
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
