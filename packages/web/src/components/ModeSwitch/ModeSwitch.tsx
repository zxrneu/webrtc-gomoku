import React from 'react';
import type { GameMode } from '../../types';
import styles from './ModeSwitch.module.css';

/**
 * 模式切换分段控件入参属性接口
 */
interface ModeSwitchProps {
  /** 当前视图模式：'online' 联机对战 | 'ai' 人机对战 */
  mode: GameMode;
  /** 切换模式回调（纯视图态切换，不触碰连接与棋局） */
  onChange: (mode: GameMode) => void;
}

/** 分段项定义（顺序即展示顺序，默认停在联机以保持老用户路径不变） */
const OPTIONS: readonly { readonly value: GameMode; readonly label: string }[] = Object.freeze([
  { value: 'online', label: '联机对战' },
  { value: 'ai', label: '人机对战' },
]);

/**
 * 模式切换分段控件 (ModeSwitch)
 *
 * 职责：在 Header 右侧提供「联机对战 ↔ 人机对战」二选一。
 * 只改视图模式（PRD P0-1）：不触碰 `conn`、不发消息、不清盘，
 * 所以「切走再切回，联机棋局原样还在、连接不中断」是天然成立的。
 */
export const ModeSwitch: React.FC<ModeSwitchProps> = ({ mode, onChange }) => {
  return (
    <div
      id="mode-switch"
      className={`${styles.switch} mode-switch`}
      role="radiogroup"
      aria-label="对局模式"
    >
      {OPTIONS.map((option) => {
        const active = option.value === mode;
        return (
          <button
            key={option.value}
            id={`mode-${option.value}-btn`}
            type="button"
            role="radio"
            aria-checked={active}
            className={`${styles.option} ${active ? styles.active : ''} mode-option`}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
          >
            <span className={`${styles.dot} ${option.value === 'online' ? styles.dotOnline : styles.dotAi}`} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
};
