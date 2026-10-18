import React from 'react';
import type { ConnectionStatus } from '@webrtc-gomoku/shared';

import styles from './ConnectionBanner.module.css';

/**
 * 连接状态条入参
 */
export interface ConnectionBannerProps {
  /** 编排器给出的唯一状态源 */
  status: ConnectionStatus;
  /** 立即重试（跳过剩余退避） */
  onRetry: () => void;
  /** 主动离开房间 */
  onLeave: () => void;
}

/** 状态 → 视觉语气（info 普通提示 / warn 网络波动 / bad 已断开） */
function toneOf(status: ConnectionStatus): 'info' | 'warn' | 'bad' {
  if (status.state === 'FAILED') return 'bad';
  if (status.state === 'CONNECTED') return 'warn';
  if (status.state === 'P2P_RECOVERING' || status.state === 'RECONNECTING') return 'warn';
  return 'info';
}

/**
 * 连接状态条（ConnectionBanner）
 *
 * 职责：把 `ConnectionStatus.label` 原样呈现给用户，并按状态给出「立即重试 / 离开房间」。
 * 文案一律来自 `shared/reconnect/status.ts`（PRD §6.4 逐字），组件内**不拼任何业务文案**，
 * 否则文案会随状态机演进逐渐漂移。
 *
 * 显示规则：
 * - `IDLE`（还没进房间）与「健康 CONNECTED」不显示，避免无意义横幅；
 * - 其余状态（连接中 / 等对手 / 协商中 / 波动恢复 / 重连退避 / 已断开 / 对手掉线）显示。
 */
export const ConnectionBanner: React.FC<ConnectionBannerProps> = ({ status, onRetry, onLeave }) => {
  const idle = status.state === 'IDLE';
  const healthy = status.state === 'CONNECTED' && status.peerOfflineInMs === null;
  if (idle || healthy) return null;

  const tone = toneOf(status);

  return (
    <div
      id="conn-banner"
      className={`${styles.banner} ${styles[tone]}`}
      data-state={status.state}
      role="status"
      aria-live="polite"
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.text}>{status.label}</span>
      {status.canRetryNow ? (
        <button type="button" className={styles.action} onClick={onRetry}>
          立即重试
        </button>
      ) : null}
      {status.canLeave ? (
        <button type="button" className={styles.ghost} onClick={onLeave}>
          离开房间
        </button>
      ) : null}
    </div>
  );
};
