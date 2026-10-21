import React, { useEffect, useState } from 'react';
import { isLobbyName, type ClientLobbyMsg, type LobbyUser, type LobbyRoom } from '@webrtc-gomoku/shared';
import type { LobbyView } from './runtime';
import styles from './Lobby.module.css';
import { LobbyActions } from './LobbyActions';

interface Props {
  view: LobbyView;
  send(message: ClientLobbyMsg): boolean;
  retry(): void;
  leave(): void;
  onRoom(): void;
  onJoin(room: string): void;
  onName(name: string): void;
  playable: boolean;
  now: number;
  onAi?: () => void;
}
const labels = { idle: '可邀请', matching: '匹配中', inviting: '处理邀请中', waiting: '等待对手',
  connecting: '正在连接', playing: '对弈中' };
const time = (ms: number) => `${Math.floor(Math.max(0, ms) / 60000).toString().padStart(2, '0')}:${
  (Math.floor(Math.max(0, ms) / 1000) % 60).toString().padStart(2, '0')}`;
const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/** 大厅的列表、邀请与匹配表达；所有网络行为交给传入的操作接口。 */
export function LobbyPanel(props: Props): React.JSX.Element {
  const { view, send, onRoom, leave, now } = props;
  const state = view.state;
  const [section, setSection] = useState<'users' | 'rooms'>(() => {
    try { return localStorage.getItem('gomoku:lobby-section') === 'rooms' ? 'rooms' : 'users'; } catch { return 'users'; }
  });
  const [query, setQuery] = useState('');
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [offset, setOffset] = useState(0);
  const [roomLimit, setRoomLimit] = useState(20);
  const users = (state?.users ?? []).filter(user => user.id !== state?.selfId);
  useEffect(() => {
    const id = window.setTimeout(() => send({ t: 'lobby-list', query, onlyAvailable, offset }), 300);
    return () => window.clearTimeout(id);
  }, [query, onlyAvailable, offset, send]);
  useEffect(() => {
    if (state && offset >= state.totalUsers && offset > 0) {
      setOffset(Math.max(0, Math.ceil(state.totalUsers / 20) - 1) * 20);
    }
  }, [state, offset]);
  const select = (next: 'users' | 'rooms') => {
    setSection(next); try { localStorage.setItem('gomoku:lobby-section', next); } catch { /* 可不保存偏好。 */ }
  };
  const busy = view.pending || !!state?.room || !!state?.invite || !!state?.match;
  const disabled = busy || view.phase !== 'ready';
  return <section id="lobby-panel" className={styles.panel} aria-label="服务大厅">
    <div className={styles.overview}>
    <div className={styles.heading}><h2>落子，遇见棋友。</h2></div>
    <Identity view={view} onName={props.onName} />
    <div className={styles.stats}>{state ? <><span className={styles.onlineDot} />在线 {state.online}<span>·</span>可加入 {state.waiting} 桌</>
      : view.phase === 'loading' ? '正在获取大厅状态…' : '暂时无法获取在线人数'}</div>
    {view.phase === 'unsupported' && <div className={styles.empty}><strong>大厅需要更新后的信令服务器</strong><p>可切换到房间联机，或使用手动信令邀请对手。</p></div>}
    {view.phase === 'offline' && <div className={styles.empty}><strong>大厅暂时不可用</strong><p>检查网络后重新连接，或切换到手动信令。</p>
      <button onClick={props.retry} className={styles.secondary}>重试</button></div>}
    <div role="status" aria-live="polite" aria-atomic="true" className={styles.notice}>{view.notice}</div>
    </div>
    <div className={styles.content}>
    <aside className={styles.launch} aria-label="开局操作">
    {state?.room ? <div className={styles.roomSummary}>
      <span className={styles.eyebrow}>你的房间</span><strong>{state.room.code}</strong>
      <p>{props.playable ? '对局已连接，轮到你时即可落子' : '正在等待对手或建立连接…'}</p>
      <div className={styles.actions}><button className={styles.primary} onClick={onRoom}>返回房间</button>
        <button className={styles.secondary} id="lobby-leave" onClick={leave}>退出房间</button></div>
      {state.room.role === 'host' && <label className={styles.check}><input type="checkbox" checked={state.room.public}
        disabled={view.pending} onChange={e => send({ t: 'lobby-visibility', public: e.target.checked })} />在大厅展示房间</label>}
    </div> : state?.invite ? <InviteCard view={view} send={send} now={now} /> : state?.match ? <div className={styles.matching}>
      <div className={styles.searching} aria-hidden="true"><i /><i /></div>
      <strong>正在为你寻找对手…</strong><span className={styles.timer}>{time(now - state.match.since)}</span>
      <p>{now - state.match.since >= 30000 ? '对手有点难找，要不要自己开一桌？' : '找到棋友后，将自动进入房间'}</p>
      <button id="match-cancel" className={styles.secondary} disabled={view.pending} onClick={() => send({ t: 'lobby-match', action: 'leave' })}>
        {view.pending ? '正在取消…' : '取消匹配'}</button></div>
      : <LobbyActions disabled={disabled} pending={view.pending} send={send} onJoin={props.onJoin} />}
      {props.onAi && <button id="lobby-ai-btn" type="button" className={styles.aiEntry} onClick={props.onAi}>
        <span aria-hidden="true">◉</span><span><strong>人机对弈</strong><small>随时开局，与 AI 练棋</small></span>
      </button>}
    </aside>
    <section className={styles.browse} aria-label="棋友与房间">
    <div className={styles.listHead}><div role="radiogroup" aria-label="大厅内容" className={styles.sections}>
      <button role="radio" aria-checked={section === 'users'} onClick={() => select('users')}>在线棋友</button>
      <button role="radio" aria-checked={section === 'rooms'} onClick={() => select('rooms')}>房间广场</button></div>
      <button className={styles.refresh} aria-label="刷新大厅" disabled={view.phase !== 'ready'}
        onClick={() => send({ t: 'lobby-list', query, onlyAvailable, offset })}><svg width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></svg></button></div>
    {section === 'users' ? <>
      <div className={styles.filters}><label className={styles.search}><span className={styles.srOnly}>搜索棋友昵称</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input id="lobby-search" value={query} maxLength={40}
        placeholder="搜索棋友昵称" onChange={e => { setQuery(e.target.value); setOffset(0); }} /></label>
      <label className={styles.check}><input type="checkbox" checked={onlyAvailable} onChange={e => { setOnlyAvailable(e.target.checked); setOffset(0); }} />只看可邀请</label></div>
      <ul className={styles.list} aria-label="在线棋友列表">{users.map(user => <UserRow key={user.id} user={user} disabled={disabled} onInvite={() => send({ t: 'lobby-invite', target: user.id })} />)}</ul>
      {view.phase === 'ready' && users.length === 0 && <div className={styles.empty}>
        <strong>{query ? '没有找到这位棋友' : '暂时没有其他在线棋友'}</strong><p>{query ? '试试其他昵称，或清空搜索' : '自己开一桌，等棋友来相遇'}</p></div>}
      {state && (offset > 0 || state.totalUsers > 20) && <div className={styles.pagination}>
        <button className={styles.secondary} disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 20))}>上一页</button>
        <span>第 {Math.floor(offset / 20) + 1} 页</span>
        <button className={styles.secondary} disabled={offset + 20 >= state.totalUsers} onClick={() => setOffset(n => n + 20)}>下一页</button>
      </div>}
    </> : <>
      <ul className={styles.list} aria-label="房间列表">{state?.rooms.slice(0, roomLimit).map(room => <RoomRow key={room.code} room={room} now={now}
        disabled={disabled} onJoin={() => send({ t: 'lobby-join', room: room.code })} />)}</ul>
      {view.phase === 'ready' && !state?.rooms.length && <div className={styles.empty}><strong>大厅里还没有等待中的房间</strong>
        <p>自己开一桌，等对手来</p><button className={styles.secondary} disabled={disabled} onClick={() => send({ t: 'lobby-create', public: true })}>创建房间</button></div>}
      {state && roomLimit < state.rooms.length && <button className={styles.more} onClick={() => setRoomLimit(n => n + 20)}>加载更多房间</button>}
      {state && state.totalRooms > 100 && <p className={styles.countHint}>仅展示前 100 桌</p>}
    </>}
    <p className={styles.footer}>相逢一局，落子无悔。</p>
    </section>
    </div>
  </section>;
}

function Identity({ view, onName }: Pick<Props, 'view' | 'onName'>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const invalid = !isLobbyName(draft);
  if (!editing) return <div className={styles.identity}><span className={styles.avatar} aria-hidden="true">{view.name.slice(0, 1)}</span><div><small>我的昵称</small><strong>{view.name}</strong></div>
    <button className={styles.textButton} onClick={() => { setDraft(view.name); setEditing(true); }}>修改</button></div>;
  return <form className={styles.nameForm} onSubmit={e => { e.preventDefault(); if (!invalid) { onName(draft); setEditing(false); } }}>
    <label htmlFor="lobby-name">我的昵称</label><input id="lobby-name" value={draft} autoFocus aria-invalid={invalid}
      aria-describedby="lobby-name-hint" maxLength={24} onChange={e => setDraft(e.target.value)}
      onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }} />
    <small id="lobby-name-hint">{invalid ? '昵称需 2–12 个字符，不能含特殊符号' : '支持中英文、数字和下划线'}</small>
    <div className={styles.actions}><button className={styles.secondary} type="submit" disabled={invalid || view.pending}>保存</button>
      <button className={styles.textButton} type="button" onClick={() => setEditing(false)}>取消</button></div></form>;
}

function UserRow({ user, disabled, onInvite }: { user: LobbyUser; disabled: boolean; onInvite(): void }) {
  return <li className={styles.userRow}>
    <span className={styles.avatar} aria-hidden="true">{user.name.slice(0, 1)}</span>
    <div className={styles.userText}><strong title={user.name}>{user.name}</strong>
      <span className={user.status === 'idle' ? styles.idle : styles.muted}>{labels[user.status]}</span></div>
    {user.status === 'idle' && <button className={styles.inviteButton} data-invite-user={user.id} disabled={disabled}
      onClick={onInvite}>邀请对局</button>}
  </li>;
}

function InviteCard({ view, send, now }: Pick<Props, 'view' | 'send' | 'now'>) {
  const invitation = view.state!.invite!;
  const incoming = invitation.to.id === view.state!.selfId;
  return <div className={styles.invitation} id={incoming ? 'incoming-invite' : 'outgoing-invite'}>
    <span className={styles.eyebrow}>{incoming ? '收到一份对局邀请' : '邀请已送达'}</span>
    <strong>{incoming ? `${invitation.from.name} 邀请你下一盘` : `等待 ${invitation.to.name} 接受…`}</strong>
    <p>{seconds(invitation.expiresAt - now)} 秒后过期 · 接受后自动组建房间</p>
    <div className={styles.actions}>{incoming ? <>
      <button className={styles.primary} disabled={view.pending} onClick={() => send({ t: 'lobby-respond', id: invitation.id, accept: true })}>接受邀请</button>
      <button className={styles.secondary} disabled={view.pending} onClick={() => send({ t: 'lobby-respond', id: invitation.id, accept: false })}>暂不接受</button></>
      : <button className={styles.secondary} disabled={view.pending} onClick={() => send({ t: 'lobby-cancel', id: invitation.id })}>取消邀请</button>}</div>
  </div>;
}

function RoomRow({ room, now, disabled, onJoin }: { room: LobbyRoom; now: number; disabled: boolean; onJoin(): void }) {
  const status = { waiting: '等待中', connecting: '满员 / 连接中', playing: '对局中', offline: '房主离线' }[room.status];
  return <li className={styles.roomRow}><div className={styles.roomTop}><strong title={room.name}>{room.name}</strong><span className={room.status === 'waiting' ? styles.idle : styles.muted}>{status}</span></div>
    <div className={styles.roomBottom}><div><button className={styles.roomCode} aria-label={`复制房号 ${room.code}`}
      onClick={async e => { const button = e.currentTarget; try { await navigator.clipboard.writeText(room.code); button.setAttribute('aria-label', '房号已复制'); } catch { /* 可手动选取房号。 */ } }}>{room.code}</button>
      <span>{room.count}/2 人{room.status === 'waiting' ? ` · 已等 ${time(now - room.createdAt)}` : ''}</span></div>
      <button className={styles.inviteButton} data-join-room={room.code} disabled={disabled || room.status !== 'waiting'} onClick={onJoin}>
        {room.status === 'waiting' ? '加入' : '不可加入'}</button></div></li>;
}
