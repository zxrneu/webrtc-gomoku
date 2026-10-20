import { describe, expect, it } from 'vitest';
import { decodeSignalingClient } from '../src/signaling-codec';

describe('客户端信令解码', () => {
  it.each([
    { t: 'create', room: 'ABCD', name: '棋友' }, { t: 'create' },
    { t: 'join', room: 'ABCD' }, { t: 'join', room: 'ABCD', name: '' },
    { t: 'signal', data: { candidate: 'ice' } }, { t: 'leave' },
    { t: 'ping' }, { t: 'ping', ts: 123 },
    { t: 'resume', room: 'ABCD', peerId: 'peer', token: 'token' },
  ])('接受协议内的 $t 消息', message => {
    expect(decodeSignalingClient(message)).toEqual(message);
  });
  it.each([null, [], 123, 'text', {}, { t: 1 }, { t: 'unknown' },
    { t: 'create', room: [] }, { t: 'create', name: 123 },
    { t: 'join' }, { t: 'join', room: false }, { t: 'join', room: 'ABCD', name: {} },
    { t: 'resume', room: 'ABCD', peerId: 'peer' },
    { t: 'resume', room: 'ABCD', peerId: {}, token: 'token' },
    { t: 'resume', room: 'ABCD', peerId: 'peer', token: null },
    { t: 'ping', ts: Number.NaN }, { t: 'ping', ts: Infinity }, { t: 'ping', ts: '123' },
    { t: 'signal' },
  ])('拒绝不符合协议的消息 %#', message => {
    expect(decodeSignalingClient(message)).toBeNull();
  });
  it('只保留已声明字段', () => {
    expect(decodeSignalingClient({ t: 'leave', room: 'ABCD' })).toEqual({ t: 'leave' });
  });
});
