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
        <span className={styles.brandStones} aria-hidden="true"><i /><i /></span><strong>五子棋</strong>
      </a>
      {lobby.view.state?.room && <button id="lobby-board-btn" type="button" className={styles.backGame} onClick={() => lobby.openGame()}>
        继续对局 · {lobby.view.state.room.code} <span aria-hidden="true">↗</span>
      </button>}
    </header>
    <main className={styles.pageMain}>
      <LobbyPanel view={lobby.view} send={lobby.runtime.send} retry={lobby.retry} leave={lobby.leave}
        playable={false} onAi={() => lobby.openGame('ai')} now={lobby.now} onRoom={lobby.openGame} onJoin={lobby.runtime.joinRoom}
        onName={name => lobby.runtime.send({ t: 'lobby-name', name })} />
    </main>
  </div>;
}
