import { useContext, useEffect, useRef, useState } from 'react';
import { isLobbyName } from '@webrtc-gomoku/shared';
import { LobbyContext } from '../../lobby/LobbyProvider';
import styles from './PlayerName.module.css';

interface Props { id: string; name: string; onSave?: (name: string) => void }

/** 昵称原位入口；保存后同步大厅身份和当前对局。 */
export function PlayerName({ id, name, onSave }: Props) {
  const lobby = useContext(LobbyContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (editing) dialog.current?.showModal(); }, [editing]);
  const close = () => { setEditing(false); button.current?.focus({ preventScroll: true }); };
  if (!onSave) return <b id={id} title={name}>{name}</b>;
  return <>
    <button id={id} ref={button} type="button" className={styles.name} aria-label="修改我的昵称" title="点击修改昵称"
      onClick={() => { setDraft(lobby?.view.name ?? name.replace(/\s*\(我\)$/, '')); setError(''); setEditing(true); }}>{name}<span aria-hidden="true"> ✎</span></button>
    {editing && <dialog ref={dialog} className={styles.dialog} aria-labelledby="name-editor-title" onCancel={close}>
      <form onSubmit={event => {
        event.preventDefault();
        if (!isLobbyName(draft)) return;
        if (lobby && !lobby.runtime.send({ t: 'lobby-name', name: draft })) { setError('暂时无法保存，请稍后再试'); return; }
        onSave(draft); close();
      }}>
        <h2 id="name-editor-title">修改昵称</h2>
        <label htmlFor="player-name-input">对方和大厅里的棋友都能看到</label>
        <input id="player-name-input" autoFocus value={draft} maxLength={24} aria-invalid={!isLobbyName(draft)}
          aria-describedby="name-editor-hint" onChange={event => setDraft(event.target.value)} />
        <p id="name-editor-hint">2–12 个字符，支持中英文、数字和下划线</p>
        {error && <p role="alert">{error}</p>}
        <div><button type="button" onClick={close}>取消</button>
          <button type="submit" disabled={!isLobbyName(draft) || lobby?.view.pending}>保存</button></div>
      </form>
    </dialog>}
  </>;
}
