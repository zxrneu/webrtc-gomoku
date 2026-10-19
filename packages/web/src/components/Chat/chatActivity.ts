import type { ChatItem } from '../../types';

/** 返回阅读位置之后的对手消息。 */
export function getUnreadMessages(messages: ChatItem[], readThroughId: string | null): ChatItem[] {
  const readIndex = messages.findIndex((item) => item.id === readThroughId);
  return messages.slice(readIndex + 1).filter((item) => item.sender === 'peer');
}
