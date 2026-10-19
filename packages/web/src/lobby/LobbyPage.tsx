import React, { useContext } from 'react';
import { LobbyContext } from './LobbyProvider';
import { LobbyPanel } from './LobbyPanel';
import styles from './Lobby.module.css';

/** 大厅独立页面：找棋友、处理邀请和选房，入座后进入棋盘。 */
export function LobbyPage(): React.JSX.Element | null {
  const lobby = useContext(LobbyContext);
  if (!lobby) return null;
  return <div className={styles.page} id="lobby-page">
    <header className={styles.pageHeader}>
      <a href="/lobby" onClick={e => { e.preventDefault(); lobby.openLobby(); }} className={styles.brand}>
        <span className={styles.brandStones} aria-hidden="true"><i /><i /></span><strong>五子棋<span>棋逢对手，落子有声</span></strong>
      </a>
      <button type="button" className={styles.backGame} onClick={lobby.openGame}>返回棋盘 <span aria-hidden="true">↗</span></button>
    </header>
    <main className={styles.pageMain}>
      <div className={styles.pageIntro}><p>一起下盘好棋</p><h1>棋友相聚，从这里开始。</h1><span>找一位在线棋友，或开一桌等待相遇。</span></div>
      <LobbyPanel view={lobby.view} send={lobby.runtime.send} retry={lobby.retry} leave={lobby.leave}
        playable={false} now={lobby.now} onRoom={lobby.openGame} onName={name => lobby.runtime.send({ t: 'lobby-name', name })} />
      <p className={styles.pageFoot}>无需注册 · 双人直连 · 每一局都是新的相遇</p>
    </main>
  </div>;
}
