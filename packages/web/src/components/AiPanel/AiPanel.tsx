import React from 'react';
import type { AiGameApi } from '../../ai/useAiGame';
import { DIFFICULTY_LABELS, DIFFICULTY_ORDER } from '../../ai/aiLabels';
import { isDifficulty } from '../../ai/aiStorage';
import { isAiBackend } from '../../ai/backendOptions';
import styles from './AiPanel.module.css';

interface AiPanelProps {
  api: Pick<AiGameApi, 'difficulty' | 'pendingDifficulty' | 'thinking' | 'setDifficulty' | 'backend' | 'setBackend'>;
  over: boolean;
}

/** 顶部人机难度与引擎选择，执子切换位于棋盒之间。 */
export const AiPanel: React.FC<AiPanelProps> = ({ api, over }) => (
  <div id="ai-card" className={styles.settings} role="group" aria-label="人机设置">
    <label className={styles.difficulty}>
      <span>难度</span>
      <select id="ai-difficulty" aria-label="选择难度" className={styles.select} value={api.pendingDifficulty}
        onChange={(event) => { if (isDifficulty(event.target.value)) api.setDifficulty(event.target.value); }}>
        {DIFFICULTY_ORDER.map(value => <option key={value} value={value}>{DIFFICULTY_LABELS[value]}</option>)}
      </select>
    </label>
    <label className={styles.difficulty}>
      <span>引擎</span>
      <select id="ai-backend" aria-label="选择 AI 引擎" className={`${styles.select} ${styles.backend}`}
        value={api.backend}
        onChange={(event) => { if (isAiBackend(event.target.value)) api.setBackend(event.target.value); }}>
        <option value="rust-wasm">Rust/WASM</option>
        <option value="ts">TS</option>
      </select>
    </label>
    {api.pendingDifficulty !== api.difficulty && (
      <p id="ai-difficulty-hint" className={styles.note} role="status">
        本局<span id="ai-difficulty-badge">{DIFFICULTY_LABELS[api.difficulty]}</span> · {DIFFICULTY_LABELS[api.pendingDifficulty]}下一局生效
      </p>
    )}
    {(api.thinking || over) && <span className={styles.status} aria-live="polite">{over ? '对局已结束' : 'AI 思考中…'}</span>}
  </div>
);
