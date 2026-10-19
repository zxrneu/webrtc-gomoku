import React, { useState, useRef, useEffect } from 'react';
import type { ChatItem } from '../../types';
import type { ChatMediaApi } from '../../media/useChatMedia';
import { describeChatItem } from '../../media/chatItems';
import { MediaBubble } from './MediaBubble';
import styles from './Chat.module.css';

/**
 * 实时聊天组件入参属性接口
 */
export interface ChatProps {
  /** 面板展开时刷新滚动位置。 */
  isActive?: boolean;
  /** 聊天消息历史记录列表 */
  messages: ChatItem[];
  /** P2P 数据通道是否已连接就绪（未连接时禁用输入框和发送按钮） */
  connected: boolean;
  /** 本端玩家昵称 */
  myName?: string;
  /** 对端玩家昵称 */
  peerName?: string;
  /** 点击发送或按回车提交文本时的回调函数 */
  onSend: (text: string) => void;
  /** 富媒体能力与动作（未联机/对端不支持时入口不渲染） */
  media?: ChatMediaApi | null;
}

/** 录音计时 mm:ss */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * P2P 对局内置聊天组件 (Chat)
 * 职责：
 * 1. 呈现基于 WebRTC RTCDataChannel 直传的双向聊天气泡（文字/图片/文件/语音/系统通知）
 * 2. 具备自动触底滚动 (Auto-scroll to bottom) 机制，新消息到达自动平滑展示
 * 3. 严格的空消息防抖与连接状态联动；富媒体入口按能力交集显隐
 */
export const Chat: React.FC<ChatProps> = ({
  messages,
  connected,
  myName,
  peerName,
  onSend,
  isActive = true,
  media = null,
}) => {
  /** 输入框内用户正在编辑的草稿文本 */
  const [text, setText] = useState('');
  /** 聊天滚动容器 DOM 引用，用于在新消息到来时控制视口滚动 */
  const listRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * 自动触底滚动机制：
   * 监听 messages 数组变化，当有新消息插入时，将滚动条高度重置到底部
   */
  useEffect(() => {
    if (isActive && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, isActive]);

  /**
   * 表单提交处理函数（支持回车键或者点击发送按钮提交）
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 防御校验：空字符串或未建立 P2P 通道时禁止发送
    if (!text.trim() || !connected) return;
    onSend(text.trim());
    setText(''); // 发送后清空输入框
  };

  const pickFile = (kind: 'image' | 'file', input: HTMLInputElement | null) => {
    const file = input?.files?.[0];
    if (file && media) media.onSendFile(kind, file);
    if (input) input.value = '';
  };

  const recording = media?.recording.active === true;

  return (
    <div className={`${styles.chatCard} card chat-card`}>
      {/* 消息滚动列表视口 */}
      <div id="chat-list" ref={listRef} className={`${styles.chatList} chat-list`} role="log" aria-label="聊天记录" aria-live="polite">
        {messages.length === 0 && <div className={styles.empty}><strong>好棋，也值得聊两句</strong><span>{connected ? '和对手打个招呼吧' : '连接对手后，就可以在这里聊天'}</span></div>}
        {messages.map((item) => {
          const isMine = item.sender === 'self';
          const isTheirs = item.sender === 'peer';
          const isSys = item.sender === 'sys';

          // 样式与身份判断
          const cls = isMine ? 'mine' : isTheirs ? 'theirs' : 'sys';
          const who = isMine ? myName || '我' : isTheirs ? peerName || '对手' : '';
          const isMedia = item.kind !== 'text';

          return (
            <div
              key={item.id}
              className={`${styles.chatItem} ${
                isMine ? styles.self : isTheirs ? styles.peer : styles.sys
              } msg ${cls}`}
            >
              {/* 系统消息居中浅灰展示，玩家消息以对话气泡呈现 */}
              {isSys ? (
                describeChatItem(item)
              ) : isMedia ? (
                <div className={styles.mediaItem}>
                  <span className={styles.mediaWho}>{who}</span>
                  <MediaBubble
                    item={item as Extract<ChatItem, { kind: 'image' | 'file' | 'audio' | 'transfer' }>}
                    onCancelTransfer={media?.onCancelTransfer}
                  />
                </div>
              ) : (
                <div className={`${styles.bubble} bubble`}>
                  {who ? who + '：' : ''}
                  {item.kind === 'text' ? item.text : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部输入框与发送操作行 */}
      <form className={`${styles.chatInputRow} chat-input-row`} onSubmit={handleSubmit}>
        {media && media.capabilities.file && (
          <>
            <button
              type="button"
              id="chat-image-btn"
              className={styles.iconBtn}
              aria-label="发送图片"
              disabled={!connected || recording}
              onClick={() => imageInputRef.current?.click()}
            >
              🖼️
            </button>
            <button
              type="button"
              id="chat-file-btn"
              className={styles.iconBtn}
              aria-label="发送文件"
              disabled={!connected || recording}
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
            <input
              ref={imageInputRef}
              id="chat-image-input"
              type="file"
              accept="image/*"
              hidden
              onChange={() => pickFile('image', imageInputRef.current)}
            />
            <input
              ref={fileInputRef}
              id="chat-file-input"
              type="file"
              hidden
              onChange={() => pickFile('file', fileInputRef.current)}
            />
          </>
        )}

        {media && media.capabilities.audio && !recording && (
          <button
            type="button"
            id="chat-voice-btn"
            className={styles.iconBtn}
            aria-label="录制语音"
            disabled={!connected}
            onClick={media.onStartRecord}
          >
            🎤
          </button>
        )}

        {recording && media ? (
          <div className={styles.recordingBar} role="status">
            <span className={styles.recDot} aria-hidden="true">●</span>
            <span className={styles.recTime}>录音中 {formatDuration(media.recording.elapsedMs)}</span>
            <button type="button" id="chat-record-cancel" className={styles.btnGhost} onClick={media.onCancelRecord}>
              取消
            </button>
            <button type="button" id="chat-record-send" className={styles.btn} onClick={media.onStopRecord}>
              发送
            </button>
          </div>
        ) : (
          <>
            <input
              id="chat-input"
              aria-label="聊天消息"
              type="text"
              maxLength={100}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={connected ? '说点什么…' : '连接后可发送消息'}
              disabled={!connected}
              autoComplete="off"
              className={styles.chatInput}
            />
            <button
              id="chat-send-btn"
              type="submit"
              disabled={!connected || !text.trim()}
              className={`${styles.btn} btn small`}
            >
              发送
            </button>
          </>
        )}
      </form>
    </div>
  );
};
