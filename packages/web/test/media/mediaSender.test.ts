import { describe, expect, it } from 'vitest';
import { MEDIA_FLOW_CONTROL, bytesToB64url, b64urlToBytes, computeSha256 } from '@webrtc-gomoku/shared';

import { sendMediaBlob } from '../../src/media/mediaSender';
import { FakeMediaChannel } from './fakes';

function bytesOf(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = i % 256;
  return out;
}

describe('sendMediaBlob', () => {
  it('按序发送 meta → 全部分片 → end，分片可还原原始字节', async () => {
    const channel = new FakeMediaChannel();
    const raw = bytesOf(1000);
    const progress: number[] = [];

    const outcome = await sendMediaBlob({
      blob: new Blob([raw], { type: 'application/octet-stream' }),
      name: 'a.bin',
      mime: 'application/octet-stream',
      kind: 'file',
      channel,
      chunkSize: 400,
      sleep: async () => {},
      yieldLoop: async () => {},
      now: () => 0,
      onProgress: (p) => progress.push(p.sentChunks),
    });

    expect(outcome).toEqual({ status: 'done' });
    const types = channel.sent.map((m) => m.t);
    expect(types[0]).toBe('media-meta');
    expect(types[types.length - 1]).toBe('media-end');
    const chunks = channel.ofType('media-chunk');
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    const joined = chunks.flatMap((c) => Array.from(b64urlToBytes(c.data)));
    expect(joined).toEqual(Array.from(raw));
    expect(progress).toEqual([1, 2, 3]);
    const meta = channel.ofType('media-meta')[0];
    expect(meta).toMatchObject({ name: 'a.bin', size: 1000, chunkSize: 400, chunks: 3, kind: 'file' });
  });

  it('空文件仍发送 1 个空分片并正常结束', async () => {
    const channel = new FakeMediaChannel();
    const outcome = await sendMediaBlob({
      blob: new Blob([], { type: 'text/plain' }),
      name: 'empty.txt',
      mime: 'text/plain',
      kind: 'file',
      channel,
      sleep: async () => {},
      yieldLoop: async () => {},
    });
    expect(outcome).toEqual({ status: 'done' });
    expect(channel.ofType('media-chunk')).toEqual([{ t: 'media-chunk', id: expect.any(String), seq: 0, data: '' }]);
    expect(channel.ofType('media-meta')[0]).toMatchObject({ size: 0, chunks: 1 });
  });

  it('背压超过阈值时等待回落后续传', async () => {
    const channel = new FakeMediaChannel();
    channel.buffered = MEDIA_FLOW_CONTROL.PAUSE_ABOVE + 1024;
    const waits: number[] = [];
    const raw = bytesOf(100);

    const pending = sendMediaBlob({
      blob: new Blob([raw]),
      name: 'a.bin',
      mime: 'application/octet-stream',
      kind: 'file',
      channel,
      sleep: async (ms) => {
        waits.push(ms);
        channel.buffered = 0; // 第一次等待后恢复
      },
      yieldLoop: async () => {},
    });
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'done' });
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it('取消时发送 media-cancel 并返回 cancelled', async () => {
    const channel = new FakeMediaChannel();
    let abort = false;
    const outcome = await sendMediaBlob({
      blob: new Blob([bytesOf(500)]),
      name: 'a.bin',
      mime: 'application/octet-stream',
      kind: 'file',
      channel,
      chunkSize: 100,
      sleep: async () => {},
      yieldLoop: async () => {
        abort = true;
      },
      shouldAbort: () => abort,
    });
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(channel.ofType('media-cancel')).toHaveLength(1);
    expect(channel.ofType('media-end')).toHaveLength(0);
  });

  it('通道未就绪返回 channel-closed', async () => {
    const channel = new FakeMediaChannel();
    channel.open = false;
    const outcome = await sendMediaBlob({
      blob: new Blob([bytesOf(10)]),
      name: 'a.bin',
      mime: '',
      kind: 'file',
      channel,
      sleep: async () => {},
      yieldLoop: async () => {},
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'channel-closed' });
  });

  it('中途发送失败返回 send-error', async () => {
    const channel = new FakeMediaChannel();
    channel.failOn.add('media-chunk');
    const outcome = await sendMediaBlob({
      blob: new Blob([bytesOf(10)]),
      name: 'a.bin',
      mime: '',
      kind: 'file',
      channel,
      sleep: async () => {},
      yieldLoop: async () => {},
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'send-error' });
  });

  it('base64 分片与原始字节一致（含高位字节）', async () => {
    const channel = new FakeMediaChannel();
    const raw = new Uint8Array([0, 255, 128, 1, 254]);
    await sendMediaBlob({
      blob: new Blob([raw]),
      name: 'a.bin',
      mime: '',
      kind: 'file',
      channel,
      sleep: async () => {},
      yieldLoop: async () => {},
    });
    const chunk = channel.ofType('media-chunk')[0];
    expect(chunk.data).toBe(bytesToB64url(raw));
  });

  it('meta 携带计算出的完整 SHA-256 哈希', async () => {
    const channel = new FakeMediaChannel();
    const raw = new TextEncoder().encode('hello sha256 sender test');
    const expectedHash = await computeSha256(raw);
    await sendMediaBlob({
      blob: new Blob([raw]),
      name: 'hello.txt',
      mime: 'text/plain',
      kind: 'file',
      channel,
      sleep: async () => {},
      yieldLoop: async () => {},
    });
    const meta = channel.ofType('media-meta')[0];
    expect(meta.hash).toBe(expectedHash);
  });

  it('发送端等待 accepted 确认后才发送分片，对端拒绝则中止并不发送任何分片', async () => {
    const channel = new FakeMediaChannel();
    const outcome = await sendMediaBlob({
      blob: new Blob([bytesOf(100)]),
      name: 'a.bin',
      mime: '',
      kind: 'file',
      channel,
      sleep: async () => {},
      yieldLoop: async () => {},
      waitForAck: async (expected) => {
        if (expected === 'accepted') {
          return { ok: false, reason: 'rejected-size' };
        }
        return { ok: true, reason: 'done' };
      },
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'rejected-size' });
    expect(channel.ofType('media-meta')).toHaveLength(1);
    expect(channel.ofType('media-chunk')).toHaveLength(0);
    expect(channel.ofType('media-end')).toHaveLength(0);
  });

  it('发送端发送 media-end 后等待 done 确认，确认后才返回 status: "done"', async () => {
    const channel = new FakeMediaChannel();
    const ackCalls: string[] = [];
    const outcome = await sendMediaBlob({
      blob: new Blob([bytesOf(50)]),
      name: 'a.bin',
      mime: '',
      kind: 'file',
      channel,
      sleep: async () => {},
      yieldLoop: async () => {},
      waitForAck: async (expected) => {
        ackCalls.push(expected);
        if (expected === 'done') {
          return { ok: true, reason: 'done' };
        }
        return { ok: true, reason: 'accepted' };
      },
    });
    expect(outcome).toEqual({ status: 'done' });
    expect(ackCalls).toEqual(['accepted', 'done']);
    expect(channel.ofType('media-end')).toHaveLength(1);
  });

  it('发送端等待 done 确认失败时返回 failed', async () => {
    const channel = new FakeMediaChannel();
    const outcome = await sendMediaBlob({
      blob: new Blob([bytesOf(50)]),
      name: 'a.bin',
      mime: '',
      kind: 'file',
      channel,
      sleep: async () => {},
      yieldLoop: async () => {},
      waitForAck: async (expected) => {
        if (expected === 'done') {
          return { ok: false, reason: 'timeout' };
        }
        return { ok: true, reason: 'accepted' };
      },
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'timeout' });
  });
});
