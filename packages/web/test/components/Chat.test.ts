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
  it('具备录音能力时入口有可见的语音消息文字', () => {
    const html = render(true);
    expect(html).toMatch(/id="chat-voice-btn"[^>]*>[\s\S]*?语音消息/);
    expect(html).not.toMatch(/id="chat-voice-btn"[^>]*disabled/);
  });
  it('HTTP 无法录音时保留禁用入口并展示 HTTPS 原因', () => {
    const html = render(false, '语音消息需要 HTTPS，请通过 HTTPS 打开页面');
    expect(html).toMatch(/id="chat-voice-btn"[^>]*disabled/);
    expect(html).toContain('语音消息需要 HTTPS');
    expect(html).toContain('aria-describedby="chat-voice-hint"');
  });
});
