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
    <button id="quick-match" className={styles.matchButton} disabled={disabled}
      onClick={() => send({ t: 'lobby-match', action: 'join' })}>
      <span aria-hidden="true">ϟ</span><span><strong>快速匹配</strong><small>与正在匹配的棋友配对</small></span>
    </button>
    <button id="lobby-create" className={styles.create} disabled={disabled} onClick={() => send({ t: 'lobby-create', public: true })}>
      <span aria-hidden="true">＋</span><span><strong>{pending ? '正在处理…' : '创建房间'}</strong><small>创建公开房间，等棋友加入</small></span>
    </button>
    <form className={styles.joinForm} aria-label="按房间号加入" action="/" method="get"
      onSubmit={event => { if (!valid || disabled) event.preventDefault(); }}>
      <label className={styles.srOnly} htmlFor="lobby-room-code">四位房间号</label>
      <input name="room" id="lobby-room-code" value={code} maxLength={4} pattern="[A-Za-z0-9]{4}" placeholder="输入四位房间号"
        autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={disabled}
        onChange={event => setCode(event.target.value.trim().toUpperCase())} />
      <button id="lobby-join-btn" className={styles.secondary} type="submit" disabled={disabled || !valid}>加入房间</button>
    </form>
  </>;
}
