import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Chat } from '../../src/components/Chat/Chat';
import type { ChatMediaApi } from '../../src/media/useChatMedia';

function render(audio: boolean, reason?: string) {
  const media: ChatMediaApi = {
    capabilities: { qr: true, file: true, audio, video: false }, recording: { active: false, elapsedMs: 0 },
    voiceUnavailableReason: reason,
    onSendFile: vi.fn(), onStartRecord: vi.fn(), onStopRecord: vi.fn(),
    onCancelRecord: vi.fn(), onCancelTransfer: vi.fn(),
  };
  return renderToStaticMarkup(React.createElement(Chat, { connected: true, messages: [], onSend: vi.fn(), media }));
}
describe('语音消息入口', () => {
  it('语音入口使用带无障碍名称的麦克风图标', () => {
    const html = render(true);
    const button = html.match(/<button[^>]*id="chat-voice-btn"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(button).toContain('aria-label="录制语音"');
    expect(button).toContain('<svg');
    expect(button).not.toContain('🎤');
    expect(button).not.toMatch(/>[^<]*语音消息/);
    expect(html).not.toMatch(/id="chat-voice-btn"[^>]*disabled/);
  });
  it('发送入口使用有无障碍名称的纸飞机图标，空消息时禁用', () => {
    const button = render(true).match(/<button[^>]*id="chat-send-btn"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(button).toContain('aria-label="发送消息"');
    expect(button).toContain('<svg');
    expect(button).toContain('disabled');
    expect(button).not.toMatch(/>\s*发送\s*</);
  });
  it('HTTP 无法录音时保留禁用入口并展示 HTTPS 原因', () => {
    const html = render(false, '语音消息需要 HTTPS，请通过 HTTPS 打开页面');
    expect(html).toMatch(/id="chat-voice-btn"[^>]*disabled/);
    expect(html).toContain('语音消息需要 HTTPS');
    expect(html).toContain('aria-describedby="chat-voice-hint"');
  });
});
