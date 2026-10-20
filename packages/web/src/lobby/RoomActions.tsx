import { useContext, useState } from 'react';
import { LobbyContext } from './LobbyProvider';
import type { ConnectionPanelProps } from '../components/Connection/ConnectionPanel';
import styles from './RoomActions.module.css';

/** 棋盘下方的房间操作，不重复昵称、聊天和对弈设置。 */
export function RoomActions(props: ConnectionPanelProps) {
  const lobby = useContext(LobbyContext);
  const [switching, setSwitching] = useState(false);
  const own = lobby?.view.state?.room;
  return <nav id="room-navigation" aria-label="房间操作" className={styles.navigation}>
    <div className={styles.links}>
      <button type="button" onClick={() => lobby?.openLobby()}>服务大厅</button>
      <button id="switch-room-btn" type="button" aria-expanded={switching} onClick={() => setSwitching(value => !value)}>{switching ? '取消切换' : '切换房间'}</button>
      <button type="button" className={styles.leave} onClick={() => lobby?.leave()}>退出房间</button>
    </div>
    {own?.role === 'host' && <label className={styles.visibility}><input type="checkbox" checked={own.public} disabled={lobby?.view.pending}
      onChange={event => lobby?.runtime.send({ t: 'lobby-visibility', public: event.target.checked })} />公开房间</label>}
    {switching && <div className={styles.switcher}>
      <button id="create-room-btn" type="button" onClick={props.onCreateRoom}>创建新房间</button>
      <label><span className={styles.srOnly}>房间号</span><input id="room-input" value={props.inputRoomCode} maxLength={4} placeholder="四位房号"
        onChange={event => props.setInputRoomCode(event.target.value.toUpperCase())} /></label>
      <button id="join-room-btn" type="button" onClick={props.onJoinRoom}>加入房间</button>
    </div>}
  </nav>;
}
