import type { ReactNode } from 'react';
import styles from './RoomSidebar.module.css';

/** 房间操作紧邻棋盘底部，聊天仍使用独立浮层。 */
export function RoomSidebar({ inRoom, children }: { inRoom: boolean; children: ReactNode }) {
  return <aside className={`${styles.side} ${inRoom ? styles.inRoom : ''} side`}>{children}</aside>;
}
