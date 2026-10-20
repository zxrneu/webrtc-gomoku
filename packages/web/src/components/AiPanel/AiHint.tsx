import type { AiGameApi } from '../../ai/useAiGame';
import { formatPoint } from '../../ai/aiLabels';
import styles from './AiHint.module.css';

type HintApi = Pick<AiGameApi, 'canHint' | 'hintThinking' | 'requestHint' | 'hint' | 'hintUnavailable'>;

/** 与悔棋、重开并排的提示入口。 */
export function AiHintButton({ api }: { api: HintApi }) {
  return <button id="ai-hint-btn" type="button" className={`${styles.button} btn`}
    title="分析推荐落点，不会自动落子" disabled={!api.canHint || api.hintThinking} onClick={api.requestHint}>
    {api.hintThinking ? '深入分析中…' : 'AI 提示'}
  </button>;
}

/** 棋盘旁的分析反馈，无提示时不占用空间。 */
export function AiHintDetails({ api }: { api: HintApi }) {
  if (!api.hint && !api.hintThinking && !api.hintUnavailable) return null;
  return <section className={styles.details} aria-label="AI 落子提示" aria-live="polite" aria-busy={api.hintThinking}>
    {api.hint ? <div id="ai-hint-explanation">
      <p className={styles.title}>推荐 {formatPoint(api.hint.point)} · 为什么下这里？</p>
      <ul className={styles.reasons}>{api.hint.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      <p className={styles.note}>青色圆环为推荐点，点击棋盘自行落子；建议不代表已证明必胜。</p>
    </div> : <p className={styles.note}>{api.hintThinking
      ? '正在深入分析，期间也可直接落子。' : '暂时没有可用建议，请重新分析。'}</p>}
  </section>;
}
