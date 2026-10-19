import { useEffect, useState } from 'react';
import type { ChatItem } from '../../types';
import { getUnreadMessages } from './chatActivity';

/** 管理聊天阅读位置和短暂预览，不影响对局或消息历史。 */
export function useChatActivity(messages: ChatItem[]) {
  const [isOpen, setIsOpen] = useState(false);
  const [readThroughId, setReadThroughId] = useState<string | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const latestId = messages[messages.length - 1]?.id ?? null;
  const unread = getUnreadMessages(messages, readThroughId);
  const latestPeer = unread[unread.length - 1];
  const previewId = latestPeer?.id;

  useEffect(() => {
    if (isOpen) setReadThroughId(latestId);
  }, [isOpen, latestId]);

  useEffect(() => {
    if (!previewId || isOpen) return;
    const timer = setTimeout(() => setDismissedId(previewId), 5000);
    return () => clearTimeout(timer);
  }, [previewId, isOpen]);

  return {
    isOpen,
    open: () => { setReadThroughId(latestId); setIsOpen(true); },
    close: () => setIsOpen(false),
    unreadCount: isOpen ? 0 : unread.length,
    preview: !isOpen && previewId !== dismissedId ? latestPeer : undefined,
  };
}
