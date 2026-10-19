import { describe, it, expect } from 'vitest';
import { pack, unpack, bytesToB64url, b64urlToBytes, encodeGameMessage, decodeGameMessage, decodeGameMessageSafe } from '../src/index';

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

  it('pack & unpack roundtrip with hostColor in ManualOfferPayload', async () => {
    const payload = {
      type: 'offer' as const,
      sdp: 'v=0 sdp-with-color',
      name: '房主',
      hostColor: 2 as const, // WHITE
    };
    const packed = await pack(payload);
    const unpacked = await unpack<typeof payload>(packed);
    expect(unpacked.hostColor).toBe(2);
  });
});

describe('GameMessage Codec & Validation', () => {
  it('encode and decode color message roundtrip (BLACK and WHITE)', () => {
    const msgBlack = { t: 'color' as const, color: 1 as const };
    const encodedBlack = encodeGameMessage(msgBlack);
    expect(decodeGameMessage(encodedBlack)).toEqual(msgBlack);

    const msgWhite = { t: 'color' as const, color: 2 as const };
    const encodedWhite = encodeGameMessage(msgWhite);
    expect(decodeGameMessage(encodedWhite)).toEqual(msgWhite);
  });

  it('encode and decode hello message with hostColor', () => {
    const msg = { t: 'hello' as const, name: 'Alice', hostColor: 2 as const };
    const encoded = encodeGameMessage(msg);
    expect(decodeGameMessage(encoded)).toEqual(msg);
  });

  it('encode and decode swap negotiation messages roundtrip', () => {
    const req = { t: 'swap-req' as const };
    expect(decodeGameMessage(encodeGameMessage(req))).toEqual(req);

    const ok = { t: 'swap-ok' as const };
    expect(decodeGameMessage(encodeGameMessage(ok))).toEqual(ok);

    const no = { t: 'swap-no' as const };
    expect(decodeGameMessage(encodeGameMessage(no))).toEqual(no);
  });


  it('rejects invalid color value in color message', () => {
    expect(() => decodeGameMessage(JSON.stringify({ t: 'color', color: 0 }))).toThrow();
    expect(() => decodeGameMessage(JSON.stringify({ t: 'color', color: 3 }))).toThrow();
    expect(() => decodeGameMessage(JSON.stringify({ t: 'color', color: '1' }))).toThrow();
    expect(() => decodeGameMessage(JSON.stringify({ t: 'color' }))).toThrow();
  });

  it('rejects invalid hostColor in hello message', () => {
    expect(() => decodeGameMessage(JSON.stringify({ t: 'hello', name: 'Alice', hostColor: 5 }))).toThrow();
  });

  it('rejects unknown message type', () => {
    expect(() => decodeGameMessage(JSON.stringify({ t: 'unknown-type' }))).toThrow(/未知/);
  });

  it('rejects invalid inputs and non-object JSON', () => {
    expect(() => decodeGameMessage('')).toThrow();
    expect(() => decodeGameMessage('{invalid json}')).toThrow();
    expect(() => decodeGameMessage('123')).toThrow();
    expect(() => decodeGameMessage('null')).toThrow();
    expect(() => decodeGameMessage('{}')).toThrow();
  });

  it('hello capabilities 合法往返，缺字段/非布尔被拒绝', () => {
    const msg = {
      t: 'hello' as const,
      name: 'Alice',
      capabilities: { qr: true, file: true, audio: true, video: false },
    };
    expect(decodeGameMessage(encodeGameMessage(msg))).toEqual(msg);
    expect(() => decodeGameMessage(JSON.stringify({ t: 'hello', name: 'A', capabilities: { file: true } }))).toThrow();
    expect(() =>
      decodeGameMessage(JSON.stringify({ t: 'hello', name: 'A', capabilities: { qr: 1, file: true, audio: true, video: false } }))
    ).toThrow();
  });

  it('media 帧往返一致', () => {
    const meta = {
      t: 'media-meta' as const,
      id: 'm1',
      kind: 'image' as const,
      name: 'a.png',
      size: 1024,
      mime: 'image/png',
      chunkSize: 32 * 1024,
      chunks: 1,
      hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    };
    expect(decodeGameMessage(encodeGameMessage(meta))).toEqual(meta);
    const chunk = { t: 'media-chunk' as const, id: 'm1', seq: 0, data: 'AAEC' };
    expect(decodeGameMessage(encodeGameMessage(chunk))).toEqual(chunk);
    expect(decodeGameMessage(encodeGameMessage({ t: 'media-end' as const, id: 'm1' }))).toEqual({ t: 'media-end', id: 'm1' });
    expect(decodeGameMessage(encodeGameMessage({ t: 'media-cancel' as const, id: 'm1' }))).toEqual({ t: 'media-cancel', id: 'm1' });
    const ack = { t: 'media-ack' as const, id: 'm1', ok: true, reason: 'accepted' as const };
    expect(decodeGameMessage(encodeGameMessage(ack))).toEqual(ack);
  });

  it('media 帧非法字段被拒绝', () => {
    expect(() => decodeGameMessage(JSON.stringify({ t: 'media-meta', id: '', kind: 'image' }))).toThrow();
    expect(() => decodeGameMessage(JSON.stringify({ t: 'media-meta', id: 'm', kind: 'video', name: 'a', size: 1, mime: '', chunkSize: 16384, chunks: 1 }))).toThrow();
    expect(() => decodeGameMessage(JSON.stringify({ t: 'media-meta', id: 'm', kind: 'file', name: 'a', size: 1, mime: '', chunkSize: 16384, chunks: 1, hash: '' }))).toThrow();
    expect(() => decodeGameMessage(JSON.stringify({ t: 'media-chunk', id: 'm', seq: -1, data: 'AA' }))).toThrow();
    expect(() => decodeGameMessage(JSON.stringify({ t: 'media-ack', id: 'm', ok: 'yes' }))).toThrow();
    expect(() => decodeGameMessage(JSON.stringify({ t: 'media-ack', id: 'm', ok: true, reason: 'bogus' }))).toThrow();
  });
});

describe('decodeGameMessageSafe（R-P0-5 可忽略路径）', () => {
  it('未知类型返回 unknown-type 而非抛错', () => {
    expect(decodeGameMessageSafe(JSON.stringify({ t: 'media-meta-future' }))).toEqual({ ok: false, reason: 'unknown-type' });
  });

  it('坏 JSON / 非对象 / 空串各有明确 reason', () => {
    expect(decodeGameMessageSafe('{bad')).toEqual({ ok: false, reason: 'bad-json' });
    expect(decodeGameMessageSafe('123')).toEqual({ ok: false, reason: 'not-object' });
    expect(decodeGameMessageSafe('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('字段非法返回 invalid-fields，合法消息返回 ok', () => {
    expect(decodeGameMessageSafe(JSON.stringify({ t: 'move', x: 'a', y: 1 }))).toEqual({ ok: false, reason: 'invalid-fields' });
    const ok = decodeGameMessageSafe(JSON.stringify({ t: 'chat', text: 'hi' }));
    expect(ok).toEqual({ ok: true, msg: { t: 'chat', text: 'hi' } });
  });
});

