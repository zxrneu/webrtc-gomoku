import { useState } from 'react';
import type { ClientLobbyMsg } from '@webrtc-gomoku/shared';
import styles from './Lobby.module.css';

interface Props {
  disabled: boolean;
  pending: boolean;
  send(message: ClientLobbyMsg): boolean;
}

/** 开局和按房间号加入；表单仅发送经过校验的四位房号。 */
export function LobbyActions({ disabled, pending, send }: Props) {
  const [code, setCode] = useState('');
  const valid = /^[A-Z0-9]{4}$/.test(code);
  return <>
    <div className={styles.launchIntro}>
      <div className={styles.miniBoard} aria-hidden="true"><i /><i /><i /><i /></div>
      <h3>来下一盘？</h3><p>找一位在线棋友，<br />在黑白之间切磋一局。</p>
    </div>
    <button id="quick-match" className={styles.matchButton} disabled={disabled}
      onClick={() => send({ t: 'lobby-match', action: 'join' })}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-12h-7z" /></svg>
      <span><strong>快速匹配</strong><small>与正在匹配的棋友配对</small></span><span aria-hidden="true" className={styles.arrow}>→</span>
    </button>
    <button id="lobby-create" className={styles.create} disabled={disabled} onClick={() => send({ t: 'lobby-create', public: true })}>
      <span aria-hidden="true">＋</span><span><strong>{pending ? '正在处理…' : '创建房间'}</strong><small>创建公开房间，等棋友加入</small></span>
    </button>
    <form className={styles.joinForm} aria-label="按房间号加入" action="/" method="get"
      onSubmit={event => { if (!valid || disabled) event.preventDefault(); }}>
      <label htmlFor="lobby-room-code">已有房号，直接赴约<span className={styles.srOnly}>，四位房间号</span></label>
      <input name="room" id="lobby-room-code" value={code} maxLength={4} pattern="[A-Za-z0-9]{4}" placeholder="输入四位房间号"
        autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={disabled}
        onChange={event => setCode(event.target.value.trim().toUpperCase())} />
      <button id="lobby-join-btn" className={styles.secondary} type="submit" disabled={disabled || !valid}>加入房间</button>
    </form>
  </>;
}
