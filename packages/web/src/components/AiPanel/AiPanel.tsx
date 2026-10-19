import React from 'react';
import { BLACK, WHITE } from '@webrtc-gomoku/core';

import type { AiGameApi } from '../../ai/useAiGame';
import { DIFFICULTY_LABELS, DIFFICULTY_ORDER, formatPoint } from '../../ai/aiLabels';
import { isDifficulty } from '../../ai/aiStorage';
import styles from './AiPanel.module.css';

/**
 * 人机设置卡入参属性接口
 */
interface AiPanelProps {
  /** 人机编排层契约（唯一数据源，组件内部不持有任何棋局状态） */
  api: AiGameApi;
  /** 当前人机棋局是否已结束（用于提示文案） */
  over: boolean;
}

/**
 * 人机设置卡 (AiPanel)
 *
 * 职责（PRD §5.2）：
 * 1. 难度下拉（简单 / 普通 / 最强）——「下一局生效」，当前局不打断；
 * 2. 执子切换（执黑先手 / 执白后手）——换边即重开；
 * 3. 悔棋（一次退两步）与重开（保留先后手与难度）；
 * 4. AI 思考状态文案（`aria-live="polite"`，读屏可感知）。
 *
 * 与联机侧的 `ConnectionPanel` 完全互斥：切到人机后整块替换，因此这里
 * 不出现房间号 / 二维码 / 换边协商等任何联机概念。
 */
export const AiPanel: React.FC<AiPanelProps> = ({ api, over }) => {
  const difficultyChanged = api.pendingDifficulty !== api.difficulty;
  const thinkingText = api.thinking ? 'AI 正在思考…' : over ? '对局已结束' : '轮到你落子';

  return (
    <div id="ai-card" className={`${styles.aiCard} card`}>
      <div className={styles.head}>
        <h2 className={styles.title}>人机对战</h2>
        <span id="ai-difficulty-badge" className={styles.badge}>
          {DIFFICULTY_LABELS[api.difficulty]}
        </span>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ai-difficulty">
          难度
        </label>
        <select
          id="ai-difficulty"
          className={styles.select}
          value={api.pendingDifficulty}
          onChange={(event) => {
            const next = event.target.value;
            // 只接受合法档位：UI 永远不传棋力参数，只传 Difficulty（架构 §8.2）
            if (isDifficulty(next)) api.setDifficulty(next);
          }}
        >
          {DIFFICULTY_ORDER.map((value) => (
            <option key={value} value={value}>
              {DIFFICULTY_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      {difficultyChanged && (
        <p id="ai-difficulty-hint" className={styles.hint}>
          难度已改为「{DIFFICULTY_LABELS[api.pendingDifficulty]}」，下一局生效
        </p>
      )}

      <div className={styles.field}>
        <span className={styles.label}>我执</span>
        <div className={styles.segmented} role="radiogroup" aria-label="选择执子颜色">
          <button
            id="ai-color-black-btn"
            type="button"
            role="radio"
            aria-checked={api.playerColor === BLACK}
            className={`${styles.segment} ${api.playerColor === BLACK ? styles.segmentActive : ''}`}
            onClick={() => api.setPlayerColor(BLACK)}
          >
            执黑（先手）
          </button>
          <button
            id="ai-color-white-btn"
            type="button"
            role="radio"
            aria-checked={api.playerColor === WHITE}
            className={`${styles.segment} ${api.playerColor === WHITE ? styles.segmentActive : ''}`}
            onClick={() => api.setPlayerColor(WHITE)}
          >
            执白（后手）
          </button>
        </div>
      </div>

      <div className={styles.players}>
        <div className={styles.playerRow}>
          <span className={`${styles.stone} ${styles.stoneBlack}`} />
          <span className={styles.playerName}>
            黑 · {api.playerColor === BLACK ? '我' : `AI（${DIFFICULTY_LABELS[api.difficulty]}）`}
          </span>
        </div>
        <div className={styles.playerRow}>
          <span className={`${styles.stone} ${styles.stoneWhite}`} />
          <span className={styles.playerName}>
            白 · {api.playerColor === WHITE ? '我' : `AI（${DIFFICULTY_LABELS[api.difficulty]}）`}
          </span>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          id="ai-undo-btn"
          type="button"
          className={`${styles.btn} btn`}
          disabled={!api.canUndo}
          onClick={api.undo}
        >
          悔棋
        </button>
        <button
          id="ai-restart-btn"
          type="button"
          className={`${styles.btn} ${styles.btnPrimary} btn primary`}
          disabled={api.thinking}
          onClick={api.restart}
        >
          重新开始
        </button>
      </div>

      <section className={styles.hintCard} aria-label="AI 落子提示">
        <button id="ai-hint-btn" type="button" className={`${styles.btn} btn`}
          disabled={!api.canHint || api.hintThinking} onClick={api.requestHint}>
          {api.hintThinking ? '正在深入分析…' : 'AI 提示'}
        </button>
        <div aria-live="polite" aria-busy={api.hintThinking}>
          {api.hint ? (
            <div id="ai-hint-explanation">
              <p className={styles.hintTitle}>推荐 {formatPoint(api.hint.point)} · 为什么下这里？</p>
              <ul className={styles.reasons}>
                {api.hint.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
              <p className={styles.hintNote}>棋盘青色圆环为推荐点，点击棋盘自行落子。解释基于当前棋形，不代表已证明必胜。</p>
            </div>
          ) : (
            <p className={styles.hintNote}>{api.hintUnavailable ? '暂时没有可用建议，请重新分析。'
              : '轮到你时可请求深度提示。分析会比对手思考更久，期间也可直接落子。'}</p>
          )}
        </div>
      </section>

      <p id="ai-thinking" className={styles.thinking} aria-live="polite">
        {thinkingText}
      </p>

      <p id="ai-last-move" className={styles.meta}>
        AI 上一手：{api.aiLastMove === null ? '-' : formatPoint([api.aiLastMove.x, api.aiLastMove.y])}
      </p>
    </div>
  );
};
