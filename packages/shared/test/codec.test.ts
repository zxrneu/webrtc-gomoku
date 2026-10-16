import { describe, it, expect } from 'vitest';
import { pack, unpack, bytesToB64url, b64urlToBytes } from '../src/index';

describe('Shared Codec (Connection Code & Compression)', () => {
  it('base64url roundtrip', () => {
    const original = new Uint8Array([0, 1, 2, 255, 254, 128, 64, 32]);
    const b64 = bytesToB64url(original);
    expect(b64).not.toContain('+');
    expect(b64).not.toContain('/');
    expect(b64).not.toContain('=');
    const recovered = b64urlToBytes(b64);
    expect(Array.from(recovered)).toEqual(Array.from(original));
  });

  it('pack & unpack roundtrip with object', async () => {
    const sdpChunk = 'v=0\r\no=- 123456789 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=candidate:1 1 UDP 2130706431 192.168.1.100 54321 typ host\r\na=candidate:2 1 UDP 1694498815 203.0.113.1 54321 typ srflx raddr 192.168.1.100 rport 54321\r\n';
    const payload = {
      type: 'offer' as const,
      sdp: sdpChunk.repeat(6),
      name: '测试玩家',
    };

    const packed = await pack(payload);
    expect(packed.startsWith('Z')).toBe(true);
    expect(packed.length).toBeLessThan(JSON.stringify(payload).length);

    const unpacked = await unpack<typeof payload>(packed);
    expect(unpacked).toEqual(payload);
  });

  it('unpack uncompressed json fallback', async () => {
    const rawJson = JSON.stringify({ type: 'answer', sdp: 'fake-sdp' });
    const unpacked = await unpack<{ type: string; sdp: string }>(rawJson);
    expect(unpacked.type).toBe('answer');
    expect(unpacked.sdp).toBe('fake-sdp');
  });

  it('empty code throws error', async () => {
    await expect(unpack('')).rejects.toThrow();
  });
});
