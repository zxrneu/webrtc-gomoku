import { describe, expect, it, vi } from 'vitest';
import { MEDIA_AUTO_ACCEPT_BYTES, bytesToB64url, computeSha256, type MediaMetaMsg } from '@webrtc-gomoku/shared';

import { MediaReceiver } from '../../src/media/mediaReceiver';
import { FakeMediaChannel } from './fakes';

function meta(over: Partial<MediaMetaMsg> = {}): MediaMetaMsg {
  return {
    t: 'media-meta',
    id: 'm1',
    kind: 'file',
    name: 'a.bin',
    size: 5,
    mime: 'application/octet-stream',
    chunkSize: 16 * 1024,
    chunks: 1,
    ...over,
  };
}

function bytes(n: number, fill = 7): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe('MediaReceiver', () => {
  it('<50MB 自动接收：meta→chunk→end 交付 Blob', async () => {
    const channel = new FakeMediaChannel();
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const receiver = new MediaReceiver(channel, { onStart, onComplete });

    receiver.handle(meta());
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(channel.ofType('media-ack')[0]).toMatchObject({ ok: true, reason: 'accepted' });

    receiver.handle({ t: 'media-chunk', id: 'm1', seq: 0, data: bytesToB64url(new TextEncoder().encode('hello')) });
    receiver.handle({ t: 'media-end', id: 'm1' });

    expect(onComplete).toHaveBeenCalledTimes(1);
    const { blob } = onComplete.mock.calls[0][0] as { blob: Blob };
    expect(await blob.text()).toBe('hello');
    expect(channel.ofType('media-ack').some((a) => a.reason === 'done')).toBe(true);
  });

  it('乱序分片按 seq 重组，重复分片幂等', async () => {
    const channel = new FakeMediaChannel();
    const onComplete = vi.fn();
    const receiver = new MediaReceiver(channel, { onComplete });
    const c0 = bytes(16 * 1024, 1);
    const c1 = bytes(16 * 1024, 2);
    const c2 = bytes(5, 3);
    receiver.handle(meta({ size: c0.length + c1.length + c2.length, chunks: 3 }));

    receiver.handle({ t: 'media-chunk', id: 'm1', seq: 1, data: bytesToB64url(c1) });
    receiver.handle({ t: 'media-chunk', id: 'm1', seq: 0, data: bytesToB64url(c0) });
    receiver.handle({ t: 'media-chunk', id: 'm1', seq: 1, data: bytesToB64url(c1) }); // 重复
    receiver.handle({ t: 'media-chunk', id: 'm1', seq: 2, data: bytesToB64url(c2) });
    receiver.handle({ t: 'media-end', id: 'm1' });

    const { blob } = onComplete.mock.calls[0][0] as { blob: Blob };
    const buf = new Uint8Array(await blob.arrayBuffer());
    expect(buf.length).toBe(c0.length + c1.length + c2.length);
    expect(buf[0]).toBe(1);
    expect(buf[16 * 1024]).toBe(2);
    expect(buf[buf.length - 1]).toBe(3);
  });

  it('缺片时判定失败，不交付残缺文件', () => {
    const channel = new FakeMediaChannel();
    const onComplete = vi.fn();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onComplete, onFailed });
    receiver.handle(meta({ size: 20000, chunks: 2, chunkSize: 16 * 1024 }));
    receiver.handle({ t: 'media-chunk', id: 'm1', seq: 0, data: bytesToB64url(bytes(5)) });
    receiver.handle({ t: 'media-end', id: 'm1' });

    expect(onComplete).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith('m1', 'incomplete');
  });

  it('≥50MB 先请求确认：accept 前不交付，accept 后正常完成', async () => {
    const channel = new FakeMediaChannel();
    const onRequest = vi.fn();
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const receiver = new MediaReceiver(channel, { onRequest, onStart, onComplete });
    const big = meta({ size: MEDIA_AUTO_ACCEPT_BYTES, chunks: Math.ceil(MEDIA_AUTO_ACCEPT_BYTES / (16 * 1024)) });

    receiver.handle(big);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
    expect(channel.ofType('media-ack')).toHaveLength(0);

    receiver.accept('m1');
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(channel.ofType('media-ack')[0]).toMatchObject({ ok: true, reason: 'accepted' });
  });

  it('等待用户确认拥有独立 60s 期限，16s 点击接受不应超时且 accept 时重新计时', () => {
    const channel = new FakeMediaChannel();
    const onRequest = vi.fn();
    const onStart = vi.fn();
    const onFailed = vi.fn();
    let now = 0;
    const intervals: (() => void)[] = [];
    const receiver = new MediaReceiver(channel, {
      onRequest,
      onStart,
      onFailed,
      now: () => now,
      setInterval: (fn) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: () => {},
    });

    const big = meta({ size: MEDIA_AUTO_ACCEPT_BYTES, chunks: Math.ceil(MEDIA_AUTO_ACCEPT_BYTES / (16 * 1024)) });
    receiver.handle(big);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(receiver.size()).toBe(1);

    // 第 16 秒：普通进度超时为 15s，但确认等待期限为 60s，不应超时
    now = 16_000;
    intervals.forEach((fn) => fn());
    expect(receiver.size()).toBe(1);
    expect(onFailed).not.toHaveBeenCalled();

    // 第 20 秒：用户点击接受
    now = 20_000;
    receiver.accept('m1');
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(channel.ofType('media-ack')[0]).toMatchObject({ ok: true, reason: 'accepted' });

    // accept 后重新计时：经过 10s（绝对时间第 30s，距离 accept 仅 10s < 15s）未超时
    now = 30_000;
    intervals.forEach((fn) => fn());
    expect(receiver.size()).toBe(1);
    expect(onFailed).not.toHaveBeenCalled();

    // 距离 accept 超过 15s（绝对时间第 36s，距离 accept 16s），传输未有新进度 → 触发超时
    now = 36_000;
    intervals.forEach((fn) => fn());
    expect(onFailed).toHaveBeenCalledWith('m1', 'timeout');
    expect(receiver.size()).toBe(0);
  });

  it('拒绝大文件：回 ack(false) + media-cancel，并回调失败', () => {
    const channel = new FakeMediaChannel();
    const onRequest = vi.fn();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onRequest, onFailed });
    receiver.handle(meta({ size: MEDIA_AUTO_ACCEPT_BYTES, chunks: Math.ceil(MEDIA_AUTO_ACCEPT_BYTES / (16 * 1024)) }));

    receiver.reject('m1', 'rejected-size');
    expect(channel.ofType('media-ack')[0]).toMatchObject({ ok: false, reason: 'rejected-size' });
    expect(channel.ofType('media-cancel')).toHaveLength(1);
    expect(onFailed).toHaveBeenCalledWith('m1', 'rejected-size');
  });

  it('对端取消 → 丢弃会话并回调', () => {
    const channel = new FakeMediaChannel();
    const onCancelled = vi.fn();
    const receiver = new MediaReceiver(channel, { onCancelledByRemote: onCancelled });
    receiver.handle(meta());
    receiver.handle({ t: 'media-cancel', id: 'm1' });
    expect(onCancelled).toHaveBeenCalledWith('m1');
    expect(receiver.size()).toBe(0);
  });

  it('meta 参数不一致（chunks 不符）→ 拒绝', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onFailed });
    receiver.handle(meta({ chunks: 99 }));
    expect(onFailed).toHaveBeenCalledWith('m1', 'invalid-meta');
    expect(channel.ofType('media-cancel')).toHaveLength(1);
  });

  it('单个分片超过声明的 chunkSize → 判失败（防内存攻击）', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onFailed });
    receiver.handle(meta({ size: 40000, chunks: 3 }));
    receiver.handle({ t: 'media-chunk', id: 'm1', seq: 0, data: bytesToB64url(bytes(20000)) });
    expect(onFailed).toHaveBeenCalledWith('m1', 'size-mismatch');
  });

  it('15s 无新分片 → 超时失败', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    let now = 0;
    const receiver = new MediaReceiver(channel, { onFailed, now: () => now });
    receiver.handle(meta());
    now = 16_000;
    receiver.handle({ t: 'media-chunk', id: 'other', seq: 0, data: 'AA' });
    expect(onFailed).toHaveBeenCalledWith('m1', 'timeout');
  });

  it('异常失败时（如分片超限）向对端发送 media-cancel 以立即止损', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onFailed });
    receiver.handle(meta({ size: 40000, chunks: 3 }));
    receiver.handle({ t: 'media-chunk', id: 'm1', seq: 0, data: bytesToB64url(bytes(20000)) });
    expect(onFailed).toHaveBeenCalledWith('m1', 'size-mismatch');
    expect(channel.ofType('media-cancel')).toHaveLength(1);
    expect(channel.ofType('media-cancel')[0]).toMatchObject({ id: 'm1' });
  });

  it('本端主动 cancel()：丢弃会话、发送 media-cancel 并回调', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onFailed });
    receiver.handle(meta());
    receiver.cancel('m1');
    expect(receiver.size()).toBe(0);
    expect(channel.ofType('media-cancel')).toHaveLength(1);
    expect(channel.ofType('media-cancel')[0]).toMatchObject({ id: 'm1' });
    expect(onFailed).toHaveBeenCalledWith('m1', 'aborted');
  });

  it('chunkSize=0 等非法分片参数被安全拒绝且不抛异常', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onFailed });
    expect(() => receiver.handle(meta({ chunkSize: 0 }))).not.toThrow();
    expect(onFailed).toHaveBeenCalledWith('m1', 'invalid-meta');
    expect(channel.ofType('media-cancel')).toHaveLength(1);
    expect(receiver.size()).toBe(0);
  });

  it('接收端安全校验：拒绝可执行扩展名（如 payload.exe）并清洗文件名', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    const onStart = vi.fn();
    const receiver = new MediaReceiver(channel, { onFailed, onStart });
    receiver.handle(meta({ name: 'payload.exe' }));
    expect(onFailed).toHaveBeenCalledWith('m1', 'executable-ext');
    expect(channel.ofType('media-ack')[0]).toMatchObject({ ok: false, reason: 'rejected-type' });
    expect(channel.ofType('media-cancel')).toHaveLength(1);
    expect(receiver.size()).toBe(0);
  });

  it('独立定时器驱动超时：对端静默无任何新帧时，15s 超时自动触发清理', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    let now = 0;
    const intervals: (() => void)[] = [];
    const receiver = new MediaReceiver(channel, {
      onFailed,
      now: () => now,
      setInterval: (fn) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: () => {},
    });

    receiver.handle(meta());
    expect(receiver.size()).toBe(1);
    expect(intervals.length).toBeGreaterThan(0);

    // 对端彻底静默，没有调用 receiver.handle
    now = 16_000;
    // 定时调度器触发
    intervals.forEach((fn) => fn());

    expect(onFailed).toHaveBeenCalledWith('m1', 'timeout');
    expect(channel.ofType('media-cancel')).toHaveLength(1);
    expect(receiver.size()).toBe(0);
  });

  it('完整性校验：SHA-256 匹配时交付，篡改或不匹配时拒绝', async () => {
    const channel = new FakeMediaChannel();
    const onComplete = vi.fn();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onComplete, onFailed });
    const content = new TextEncoder().encode('hello world');
    const correctHash = await computeSha256(content);

    // 1. 篡改哈希被拒绝
    receiver.handle(meta({ id: 'm-bad', size: content.length, hash: 'badhash' }));
    receiver.handle({ t: 'media-chunk', id: 'm-bad', seq: 0, data: bytesToB64url(content) });
    receiver.handle({ t: 'media-end', id: 'm-bad' });
    await new Promise((r) => setTimeout(r, 10)); // 等待哈希异步计算
    expect(onComplete).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith('m-bad', 'hash-mismatch');

    // 2. 正确哈希成功交付
    receiver.handle(meta({ id: 'm-good', size: content.length, hash: correctHash }));
    receiver.handle({ t: 'media-chunk', id: 'm-good', seq: 0, data: bytesToB64url(content) });
    receiver.handle({ t: 'media-end', id: 'm-good' });
    await new Promise((r) => setTimeout(r, 10));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(channel.ofType('media-ack').some((a) => a.id === 'm-good' && a.reason === 'done')).toBe(true);
  });

  it('大文件未确认时（awaiting）提前到达的分片不被缓冲占用内存', () => {
    const channel = new FakeMediaChannel();
    const onRequest = vi.fn();
    const onProgress = vi.fn();
    const receiver = new MediaReceiver(channel, { onRequest, onProgress });
    const big = meta({
      id: 'big-1',
      size: MEDIA_AUTO_ACCEPT_BYTES,
      chunks: Math.ceil(MEDIA_AUTO_ACCEPT_BYTES / (16 * 1024)),
    });
    receiver.handle(big);
    expect(onRequest).toHaveBeenCalledTimes(1);

    // 未确认前到达的分片：直接丢弃，不触发 progress，不占缓冲
    receiver.handle({ t: 'media-chunk', id: 'big-1', seq: 0, data: bytesToB64url(bytes(1000)) });
    expect(onProgress).not.toHaveBeenCalled();

    // 确认后才进入接收状态
    receiver.accept('big-1');
    receiver.handle({ t: 'media-chunk', id: 'big-1', seq: 0, data: bytesToB64url(bytes(1000)) });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('reset 让所有未完成会话失败（断线不无限等待）', () => {
    const channel = new FakeMediaChannel();
    const onFailed = vi.fn();
    const receiver = new MediaReceiver(channel, { onFailed });
    receiver.handle(meta());
    receiver.reset();
    expect(onFailed).toHaveBeenCalledWith('m1', 'channel-closed');
    expect(receiver.size()).toBe(0);
  });
});
