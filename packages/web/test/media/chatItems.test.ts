import { describe, expect, it } from 'vitest';

import { chatTime, createTextItem, createTransferItem, describeChatItem } from '../../src/media/chatItems';

describe('ChatItem 构造与预览文案', () => {
  it('文本消息带 kind 与时间', () => {
    const item = createTextItem('peer', 'hi', 'id1');
    expect(item).toMatchObject({ id: 'id1', sender: 'peer', kind: 'text', text: 'hi' });
    expect(item.time).toMatch(/\d{1,2}:\d{2}/);
  });

  it('传输气泡默认进度为 0', () => {
    const item = createTransferItem({
      sender: 'self',
      mediaId: 'm1',
      direction: 'send',
      name: 'a.bin',
      size: 100,
      status: 'sending',
    });
    expect(item).toMatchObject({ kind: 'transfer', done: 0, status: 'sending' });
  });

  it('每种 kind 都有可读预览文案', () => {
    const base = { id: 'x', sender: 'peer' as const, time: '12:00' };
    expect(describeChatItem({ ...base, kind: 'text', text: '你好' })).toBe('你好');
    expect(describeChatItem({ ...base, kind: 'image', mediaId: 'm', url: 'blob:x', name: 'a.png', size: 1 })).toBe('[图片]');
    expect(describeChatItem({ ...base, kind: 'file', mediaId: 'm', url: 'blob:x', name: 'a.pdf', size: 1, mime: 'application/pdf' })).toBe('[文件] a.pdf');
    expect(describeChatItem({ ...base, kind: 'audio', mediaId: 'm', url: 'blob:x', durationMs: 3000 })).toBe('[语音]');
    expect(
      describeChatItem({
        ...base,
        kind: 'transfer',
        mediaId: 'm',
        direction: 'receive',
        name: 'big.zip',
        size: 10,
        done: 5,
        status: 'receiving',
      }),
    ).toBe('[接收中] big.zip');
  });

  it('chatTime 返回 HH:mm', () => {
    expect(chatTime(new Date(2026, 0, 1, 9, 5))).toMatch(/\d{1,2}:\d{2}/);
  });
});
