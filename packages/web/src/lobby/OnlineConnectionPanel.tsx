import React, { useContext, useEffect, useState } from 'react';
import { LobbyContext } from './LobbyProvider';
import { LegacyConnectionPanel, type ConnectionPanelProps } from '../components/Connection/ConnectionPanel';
import styles from './Lobby.module.css';
type Tab = 'lobby' | 'room' | 'manual';
const tabs: { key: Tab; label: string }[] = [
  { key: 'lobby', label: '服务大厅' }, { key: 'room', label: '房间联机' }, { key: 'manual', label: '手动信令' },
];

/** 三个连接入口共享同一局游戏；大厅邀请不触碰棋局消息。 */
export function OnlineConnectionPanel(props: ConnectionPanelProps): React.JSX.Element {
  const lobby = useContext(LobbyContext);
  const [tab, setTab] = useState<Tab>('room');
  const choose = (next: Tab) => { if (next === 'lobby') { lobby?.openLobby(); return; } setTab(next); props.setActiveTab(next); };
  useEffect(() => {
    if (lobby?.view.name) props.setName(lobby.view.name);
  }, [lobby?.view.name]);
  useEffect(() => {
    if (props.roomCode) { setTab('room'); props.setActiveTab('room'); }
  }, [props.roomCode]);
  useEffect(() => {
    lobby?.runtime.send({ t: 'lobby-ready', ready: props.connected || (props.activeTab === 'manual' && props.flow !== 'idle') });
  }, [props.connected, props.flow, props.activeTab, lobby?.view.phase]);
  if (!lobby) return <LegacyConnectionPanel {...props} />;
  const own = lobby.view.state?.room;
  return <div className={styles.onlinePanel}>
    <nav className={styles.nav} aria-label="联机方式">
      {tabs.map(item => <button key={item.key} type="button" data-online-tab={item.key}
        data-tab={item.key} aria-pressed={tab === item.key} onClick={() => choose(item.key)}>{item.label}</button>)}
    </nav>
    <div className={styles.legacy} hidden={tab === 'lobby'}>
      <LegacyConnectionPanel {...props} />
      {tab === 'room' && own && <div className={styles.roomTools}>
        {own.role === 'host' && <label><input type="checkbox" checked={own.public} disabled={lobby.view.pending}
          onChange={event => lobby.runtime.send({ t: 'lobby-visibility', public: event.target.checked })} /> 在房间广场展示</label>}
        <button type="button" onClick={() => { lobby.leave(); lobby.openLobby(); }}>离开房间，返回大厅</button>
      </div>}
    </div>
  </div>;
}
