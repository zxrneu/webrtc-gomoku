import React, { useEffect, useRef } from 'react';
import type { ChatItem } from '../../types';
import { Chat, type ChatProps } from './Chat';
import { useChatActivity } from './useChatActivity';
import styles from './GameSidebar.module.css';

interface GameSidebarProps {
  children: React.ReactNode;
  chat: Omit<ChatProps, 'messages' | 'peerName' | 'isActive'> | null;
  messages: ChatItem[];
  peerName: string;
}

const ChatIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5a10 10 0 0 1 20 0Z" transform="translate(1 -1) scale(.9)" />
    <path d="M7 9h10M7 13h6" />
  </svg>
);

/** 用独立 Tab 呈现对局设置和聊天，并提供视口内的消息入口。 */
export function GameSidebar({ children, chat, messages, peerName }: GameSidebarProps) {
  const activity = useChatActivity(messages);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);
  const focusPanelRef = useRef(true);
  const hasChat = chat !== null;
  const open = () => {
    focusPanelRef.current = true;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activity.open();
  };
  const openTab = () => { open(); focusPanelRef.current = false; };
  const close = () => { restoreFocusRef.current = true; activity.close(); };
  useEffect(() => {
    if (activity.isOpen && hasChat && focusPanelRef.current) panelRef.current?.focus({ preventScroll: true });
    if (!activity.isOpen && restoreFocusRef.current) {
      const previous = returnFocusRef.current;
      const target = previous?.id === 'chat-tab' ? document.getElementById('game-tab')
        : previous?.isConnected ? previous : document.getElementById('chat-launcher');
      target?.focus({ preventScroll: true });
      restoreFocusRef.current = false;
    }
  }, [activity.isOpen, hasChat]);
  if (!chat) return <>{children}</>;
  return (
    <div className={styles.workspace}>
      <SidebarTabs isOpen={activity.isOpen} unreadCount={activity.unreadCount} onOpen={openTab} onClose={activity.close} />
      <div id="game-panel" role="tabpanel" aria-labelledby="game-tab" hidden={activity.isOpen} className={styles.gamePanel}>{children}</div>
      <div id="chat-panel" role="tabpanel" aria-labelledby="chat-tab" hidden={!activity.isOpen} className={styles.chatPanel}
        ref={panelRef} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
        <div className={styles.panelHead}>
          <div><strong>对局聊天</strong><span>{peerName ? `与 ${peerName} 聊聊` : '边下棋，边聊聊'}</span></div>
          <button type="button" onClick={close} aria-label="收起聊天" className={styles.close}>收起 <span aria-hidden="true">×</span></button>
        </div>
        <Chat {...chat} messages={messages} peerName={peerName} isActive={activity.isOpen} />
      </div>
      {!activity.isOpen && <ChatNotice unreadCount={activity.unreadCount} preview={activity.preview} peerName={peerName} onOpen={open} />}
    </div>
  );
}

interface SidebarTabsProps {
  isOpen: boolean;
  unreadCount: number;
  onOpen: () => void;
  onClose: () => void;
}

function SidebarTabs({ isOpen, unreadCount, onOpen, onClose }: SidebarTabsProps) {
  const select = (chat: boolean) => {
    if (chat) onOpen(); else onClose();
    document.getElementById(chat ? 'chat-tab' : 'game-tab')?.focus();
  };
  return (
    <div role="tablist" aria-label="对局侧栏" className={styles.tabs} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      select(event.key === 'End' || (event.key !== 'Home' && !isOpen));
    }}>
      <button id="game-tab" role="tab" aria-selected={!isOpen} aria-controls="game-panel" tabIndex={isOpen ? -1 : 0} onClick={onClose}>对局</button>
      <button id="chat-tab" role="tab" aria-selected={isOpen} aria-controls="chat-panel" tabIndex={isOpen ? 0 : -1} onClick={onOpen}>
        <ChatIcon />聊天{unreadCount > 0 && <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
    </div>
  );
}

interface ChatNoticeProps {
  unreadCount: number;
  preview?: ChatItem;
  peerName: string;
  onOpen: () => void;
}

function ChatNotice({ unreadCount, preview, peerName, onOpen }: ChatNoticeProps) {
  return (
    <div className={styles.notices}>
      <div role="status" aria-live="polite" className={styles.announcement}>{unreadCount > 0 ? `${unreadCount} 条未读聊天消息` : ''}</div>
      {preview && <button id="chat-preview" className={styles.preview} onClick={onOpen}>
        <span className={styles.previewHeading}><strong>{peerName || '对手'}</strong><span>新消息 · 点击回复</span></span>
        <span className={styles.previewText}>{preview.text}</span>
      </button>}
      <button id="chat-launcher" className={styles.launcher} onClick={onOpen} aria-controls="chat-panel" aria-expanded={false}
        aria-label={unreadCount ? `打开聊天，${unreadCount} 条未读消息` : '打开聊天'}>
        <ChatIcon /><span>聊天</span>{unreadCount > 0 && <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
    </div>
  );
}
