import React, { useState, useRef, useEffect } from 'react';
import type { ChatItem } from '../../types';
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
}

/**
 * P2P 对局内置聊天组件 (Chat)
 * 职责：
 * 1. 呈现基于 WebRTC RTCDataChannel 直传的双向聊天气泡（己方、对方、系统通知）
 * 2. 具备自动触底滚动 (Auto-scroll to bottom) 机制，新消息到达自动平滑展示
 * 3. 严格的空消息防抖与连接状态联动
 */
export const Chat: React.FC<ChatProps> = ({ messages, connected, myName, peerName, onSend, isActive = true }) => {
  /** 输入框内用户正在编辑的草稿文本 */
  const [text, setText] = useState('');
  /** 聊天滚动容器 DOM 引用，用于在新消息到来时控制视口滚动 */
  const listRef = useRef<HTMLDivElement | null>(null);

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
          const displayText = isSys ? item.text : (who ? who + '：' : '') + item.text;

          return (
            <div
              key={item.id}
              className={`${styles.chatItem} ${
                isMine ? styles.self : isTheirs ? styles.peer : styles.sys
              } msg ${cls}`}
            >
              {/* 系统消息居中浅灰展示，玩家消息以对话气泡呈现 */}
              {isSys ? (
                displayText
              ) : (
                <div className={`${styles.bubble} bubble`}>{displayText}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部输入框与发送操作行 */}
      <form className={`${styles.chatInputRow} chat-input-row`} onSubmit={handleSubmit}>
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
      </form>
    </div>
  );
};
