import styles from './RoomHeading.module.css';

export interface RoomHeadingProps {
  code: string;
  connected: boolean;
  onCopy: () => void;
}

/** 房间号紧邻棋盘，点击房号或邀请按钮复制链接。 */
export function RoomHeading({ code, connected, onCopy }: RoomHeadingProps) {
  return <div id="room-info" className={styles.heading}>
    <span className={`${styles.status} ${connected ? styles.connected : ''}`}>
      <i />{connected ? '已直连' : '等棋友'}
    </span>
    <button id="copy-link-btn" type="button" className={styles.code} onClick={onCopy}
      aria-label="复制房间邀请链接" title="点击复制邀请链接">
      <span>房间</span><b id="room-code-text">{code}</b><span aria-hidden="true">⧉</span>
    </button>
    <button id="room-invite-btn" type="button" className={styles.settings} onClick={onCopy}>邀请</button>
  </div>;
}
