import type { GameMode } from '../types';

/** 在线入口根据模式与已有房间选择页面，不创建或退出房间。 */
export function gamePage(mode: GameMode, hasRoom: boolean): 'lobby' | 'game' {
  return mode === 'online' && !hasRoom ? 'lobby' : 'game';
}
