/**
 * 富媒体气泡：图片 / 文件 / 语音 / 传输进度。
 *
 * 安全：文件名只作为 React 文本节点渲染（自动转义），不使用 innerHTML；
 * 下载链接使用 download 属性，URL 全部来自本端 Blob。
 */
import React from 'react';
import { formatBytes, isSvg } from '@webrtc-gomoku/shared';

import type { ChatItem } from '../../types';
import styles from './Chat.module.css';

type MediaItem = Extract<ChatItem, { kind: 'image' | 'file' | 'audio' | 'transfer' }>;

export interface MediaBubbleProps {
  item: MediaItem;
  /** 发送方可取消进行中的传输 */
  onCancelTransfer?: (mediaId: string) => void;
}

export const MediaBubble: React.FC<MediaBubbleProps> = ({ item, onCancelTransfer }) => {
  switch (item.kind) {
    case 'image': {
      // 安全防御：SVG 可内嵌可执行脚本，若在新标签页打开（target="_blank"）会执行同源脚本；
      // 降级为安全文件下载卡片，点击触发下载而不是在新标签页直接执行同源脚本
      if (isSvg(item.name)) {
        return (
          <a className={styles.fileBubble} href={item.url} download={item.name}>
            <span className={styles.fileIcon} aria-hidden="true">📄</span>
            <span className={styles.fileMeta}>
              <strong>{item.name}</strong>
              <small>{formatBytes(item.size)}</small>
            </span>
            <span className={styles.download}>下载</span>
          </a>
        );
      }
      return (
        <a
          className={styles.imageBubble}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`查看图片 ${item.name}`}
        >
          <img className={styles.image} src={item.url} alt={item.name} />
          <small className={styles.imageMeta}>{formatBytes(item.size)}</small>
        </a>
      );
    }
    case 'file':
      return (
        <a className={styles.fileBubble} href={item.url} download={item.name}>
          <span className={styles.fileIcon} aria-hidden="true">📄</span>
          <span className={styles.fileMeta}>
            <strong>{item.name}</strong>
            <small>{formatBytes(item.size)}</small>
          </span>
          <span className={styles.download}>下载</span>
        </a>
      );
    case 'audio':
      return (
        <div className={styles.audioBubble}>
          <audio className={styles.audio} src={item.url} controls aria-label="语音消息" />
          <small>{Math.max(1, Math.round(item.durationMs / 1000))}″</small>
        </div>
      );
    case 'transfer': {
      const pct = item.size > 0 ? Math.min(100, Math.round((item.done / item.size) * 100)) : 100;
      const statusText =
        item.status === 'failed'
          ? '传输失败'
          : item.status === 'cancelled'
            ? '已取消'
            : `${item.direction === 'send' ? '发送中' : '接收中'} ${pct}%`;
      return (
        <div className={styles.transferBubble} role="status">
          <div className={styles.transferHead}>
            <strong>{item.name}</strong>
            <small>
              {formatBytes(item.done)} / {formatBytes(item.size)}
            </small>
          </div>
          <div className={styles.progress}>
            <span className={styles.progressBar} style={{ width: `${pct}%` }} />
          </div>
          <div className={styles.transferFoot}>
            <span>{statusText}</span>
            {(item.status === 'sending' || item.status === 'receiving') && onCancelTransfer && (
              <button type="button" className={styles.cancelLink} onClick={() => onCancelTransfer(item.mediaId)}>
                取消
              </button>
            )}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
};
