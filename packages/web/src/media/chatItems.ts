/**
 * ChatItem 构造与未读预览文案（组件不直接拼字符串）。
 */
import type { ChatItem, TransferStatus } from '../types';

/** 当前时间 "HH:mm"（聊天时间戳） */
export function chatTime(date: Date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 追加一条文本/系统消息 */
export function createTextItem(sender: 'self' | 'peer' | 'sys', text: string, id?: string): ChatItem {
  return {
    id: id ?? Math.random().toString(36).slice(2),
    sender,
    kind: 'text',
    text,
    time: chatTime(),
  };
}

/** 追加一条传输进度气泡 */
export function createTransferItem(input: {
  id?: string;
  sender: 'self' | 'peer';
  mediaId: string;
  direction: 'send' | 'receive';
  name: string;
  size: number;
  done?: number;
  status: TransferStatus;
}): ChatItem {
  return {
    id: input.id ?? Math.random().toString(36).slice(2),
    sender: input.sender,
    kind: 'transfer',
    mediaId: input.mediaId,
    direction: input.direction,
    name: input.name,
    size: input.size,
    done: input.done ?? 0,
    status: input.status,
    time: chatTime(),
  };
}

/** 未读预览/无障碍文案：所有 kind 都必须有可读文本 */
export function describeChatItem(item: ChatItem): string {
  switch (item.kind) {
    case 'text':
      return item.text;
    case 'image':
      return '[图片]';
    case 'file':
      return `[文件] ${item.name}`;
    case 'audio':
      return '[语音]';
    case 'transfer':
      return item.direction === 'send' ? `[发送中] ${item.name}` : `[接收中] ${item.name}`;
    default:
      return '';
  }
}
