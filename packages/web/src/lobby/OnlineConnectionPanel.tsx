import React, { useContext, useEffect } from 'react';
import { LobbyContext } from './LobbyProvider';
import { LegacyConnectionPanel, type ConnectionPanelProps } from '../components/Connection/ConnectionPanel';
import styles from './Lobby.module.css';
import { RoomActions } from './RoomActions';
/** 服务器页面只提供自动房间连接与大厅入口。 */
export function OnlineConnectionPanel(props: ConnectionPanelProps): React.JSX.Element {
  const lobby = useContext(LobbyContext);
  useEffect(() => {
    if (lobby?.view.name) props.setName(lobby.view.name);
  }, [lobby?.view.name]);
  useEffect(() => {
    lobby?.runtime.send({ t: 'lobby-ready', ready: props.connected });
  }, [props.connected, lobby?.view.phase]);
  if (props.roomHeadingExternal) return <RoomActions key={props.roomCode} {...props} />;
  if (!lobby) return <LegacyConnectionPanel {...props} method="room" />;
  const own = lobby.view.state?.room;
  return <div className={styles.onlinePanel}>
    <nav className={styles.nav} aria-label="联机方式">
      <button type="button" data-online-tab="lobby" onClick={lobby.openLobby}>服务大厅</button>
      <button type="button" data-online-tab="room" aria-pressed="true">房间联机</button>
    </nav>
    <div className={styles.legacy}>
      <LegacyConnectionPanel {...props} method="room" />
      {own && <div className={styles.roomTools}>
        {own.role === 'host' && <label><input type="checkbox" checked={own.public} disabled={lobby.view.pending}
          onChange={event => lobby.runtime.send({ t: 'lobby-visibility', public: event.target.checked })} /> 在房间广场展示</label>}
        <button type="button" onClick={() => { lobby.leave(); lobby.openLobby(); }}>离开房间，返回大厅</button>
      </div>}
    </div>
  </div>;
}
