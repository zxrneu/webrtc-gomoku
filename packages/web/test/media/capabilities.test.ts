import { describe, expect, it } from 'vitest';
import { voiceMessageUnavailableReason } from '../../src/media/capabilities';

const ready = { connected: true, secureContext: true, localAudio: true, peerAudio: true };
describe('语音消息不可用原因', () => {
  it('局域网 HTTP 明确提示 HTTPS 要求', () => {
    expect(voiceMessageUnavailableReason({ ...ready, secureContext: false, localAudio: false })).toContain('HTTPS');
  });
  it('连接前提示先连接对手', () => {
    expect(voiceMessageUnavailableReason({ ...ready, connected: false })).toContain('连接对手');
  });
  it('本端缺少录音 API 时说明浏览器不支持', () => {
    expect(voiceMessageUnavailableReason({ ...ready, localAudio: false })).toContain('当前浏览器');
  });
  it('尚未收到能力时说明正在确认', () => {
    expect(voiceMessageUnavailableReason({ ...ready, peerAudio: null })).toContain('确认');
  });
  it('旧对手不支持语音时说明对方不支持', () => {
    expect(voiceMessageUnavailableReason({ ...ready, peerAudio: false })).toContain('对方');
  });
  it('双方支持时没有禁用原因', () => {
    expect(voiceMessageUnavailableReason(ready)).toBeUndefined();
  });
});
