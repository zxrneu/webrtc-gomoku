import React, { useState, useRef, useEffect } from 'react';
import type { ChatItem } from '../../types';
import styles from './Chat.module.css';

interface ChatProps {
  messages: ChatItem[];
  connected: boolean;
  myName?: string;
  peerName?: string;
  onSend: (text: string) => void;
}

export const Chat: React.FC<ChatProps> = ({ messages, connected, myName, peerName, onSend }) => {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !connected) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <div className={`${styles.chatCard} card chat-card`}>
      <div className={`${styles.chatHead} chat-head`}>对局聊天</div>
      <div id="chat-list" ref={listRef} className={`${styles.chatList} chat-list`}>
        {messages.map((item) => {
          const isMine = item.sender === 'self';
          const isTheirs = item.sender === 'peer';
          const isSys = item.sender === 'sys';

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
              {isSys ? (
                displayText
              ) : (
                <div className={`${styles.bubble} bubble`}>{displayText}</div>
              )}
            </div>
          );
        })}
      </div>
      <form className={`${styles.chatInputRow} chat-input-row`} onSubmit={handleSubmit}>
        <input
          id="chat-input"
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
