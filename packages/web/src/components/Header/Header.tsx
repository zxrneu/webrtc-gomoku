import React from 'react';
import type { GameMode } from '../../types';
import { ModeSwitch } from '../ModeSwitch/ModeSwitch';
import styles from './Header.module.css';

/**
 * 顶部导航栏入参属性接口
 */
interface HeaderProps {
  /** 当前连接状态：online (P2P 已通), signaling (信令握手/等待中), offline (未连接) */
  status: 'online' | 'signaling' | 'offline';
  /** 状态胶囊徽标内展示的文本（如 "未连接" / "信令就绪" / "对局直连"） */
  statusText: string;
  /** 当前视图模式（联机 / 人机） */
  mode: GameMode;
  /** 切换视图模式回调（纯视图态，不触碰连接与棋局） */
  onModeChange: (mode: GameMode) => void;
  children?: React.ReactNode;
  compact?: boolean;
}

/**
 * 顶部导航栏组件 (Header)
 * 职责：
 * 1. 展现五子棋黑白 Logo 与产品定位副标题
 * 2. 「联机对战 ↔ 人机对战」模式切换（PRD §5.1，默认停在联机以保持老用户路径）
 * 3. 醒目展示全站连接状态呼吸灯胶囊徽标 (online / signaling / offline)
 */
export const Header: React.FC<HeaderProps> = ({ status, statusText, mode, onModeChange, children, compact = false }) => {
  // 根据状态切换不同配色的呼吸灯样式类名
  const badgeClass =
    status === 'online'
      ? `${styles.badge} ${styles.badgeOnline} badge online`
      : status === 'signaling'
      ? `${styles.badge} ${styles.badgeSignaling} badge signaling`
      : `${styles.badge} ${styles.badgeOffline} badge offline`;

  return (
    <header className={`${styles.topbar} ${compact ? styles.compact : ''} topbar`}>
      {/* 品牌 Logo 与标题区 */}
      <div className={`${styles.titleGroup} title`}>
        <span className={`${styles.logo} logo`}>
          <i className={`${styles.stoneBlack} b`} />
          <i className={`${styles.stoneWhite} w`} />
        </span>
        <div className={styles.titleText}>
          <h1>{compact ? '五子棋' : '五子棋 · P2P 联机'}</h1>
          <p className={`${styles.subtitle} subtitle`}>
            {__LOBBY_ENABLED__ ? '进入房间自动连接 · 也可随时切换人机对战' : '邀请对局无需服务器，微信互发连接码即玩'}
          </p>
        </div>
      </div>

      {/* 模式切换分段控件 + 动态连接状态胶囊徽标 */}
      <div className={styles.rightGroup}>
        <ModeSwitch mode={mode} onChange={onModeChange} />

        {children ? <div className={styles.gameControls}>{children}</div> : <div id="conn-badge" className={badgeClass}>
          <span className={`${styles.dot} dot`} />
          <span id="conn-text">{statusText}</span>
        </div>}
      </div>
    </header>
  );
};
