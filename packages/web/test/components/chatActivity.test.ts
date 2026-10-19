import { describe, expect, it } from 'vitest';
import { getUnreadMessages } from '../../src/components/Chat/chatActivity';
import type { ChatItem } from '../../src/types';

const messages: ChatItem[] = [
  { id: '1', sender: 'peer', text: '你好', time: '12:00' },
  { id: '2', sender: 'sys', text: '已连接', time: '12:00' },
  { id: '3', sender: 'self', text: '你好呀', time: '12:00' },
  { id: '4', sender: 'peer', text: '轮到你了', time: '12:01' },
];

describe('聊天未读消息', () => {
  it('只统计对手消息，不将系统和自己发送的消息计入未读', () => {
    expect(getUnreadMessages(messages, null).map((item) => item.id)).toEqual(['1', '4']);
  });
  it('查看聊天后只统计阅读位置之后的消息', () => {
    expect(getUnreadMessages(messages, '1').map((item) => item.id)).toEqual(['4']);
  });
  it('读到最新消息时未读为空', () => {
    expect(getUnreadMessages(messages, '4')).toEqual([]);
  });
  it('换房清空消息后不残留未读', () => {
    expect(getUnreadMessages([], '4')).toEqual([]);
  });
  it('旧阅读位置在新房间不存在时，新消息仍计为未读', () => {
    expect(getUnreadMessages(messages, 'old-room').map((item) => item.id)).toEqual(['1', '4']);
  });
});
