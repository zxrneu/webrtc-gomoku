import React from 'react';
import styles from './Header.module.css';

interface HeaderProps {
  status: 'online' | 'signaling' | 'offline';
  statusText: string;
}

export const Header: React.FC<HeaderProps> = ({ status, statusText }) => {
  const badgeClass =
    status === 'online'
      ? `${styles.badge} ${styles.badgeOnline} badge online`
      : status === 'signaling'
      ? `${styles.badge} ${styles.badgeSignaling} badge signaling`
      : `${styles.badge} ${styles.badgeOffline} badge offline`;

  return (
    <header className={`${styles.topbar} topbar`}>
      <div className={`${styles.titleGroup} title`}>
        <span className={`${styles.logo} logo`}>
          <i className={`${styles.stoneBlack} b`} />
          <i className={`${styles.stoneWhite} w`} />
        </span>
        <div className={styles.titleText}>
          <h1>五子棋 · P2P 联机</h1>
          <p className={`${styles.subtitle} subtitle`}>
            WebRTC 浏览器直连对战 · 邀请对局无需服务器，微信互发连接码即玩
          </p>
        </div>
      </div>
      <div id="conn-badge" className={badgeClass}>
        <span className={`${styles.dot} dot`} />
        <span id="conn-text">{statusText}</span>
      </div>
    </header>
  );
};
