/**
 * 富媒体接收器：按会话重组分片（乱序缓冲、重复幂等、缺片判失败）。
 *
 * 安全策略：
 * - meta 的大小/分片参数/分片实际字节数都复核，异常直接拒绝；
 * - ≥50MB 先请求用户确认（`onRequest`），确认前只缓冲不交付；
 * - 15s 无新分片判定超时（断线由调用方 `reset()` 兜底）。
 */
import {
  MEDIA_AUTO_ACCEPT_BYTES,
  MEDIA_CHUNK_SIZE,
  MEDIA_CONFIRM_TIMEOUT_MS,
  MEDIA_MAX_BYTES,
  MEDIA_PROGRESS_TIMEOUT_MS,
  b64urlToBytes,
  computeSha256,
  planChunks,
  sanitizeFileName,
  validateFilePayload,
  type GameMessage,
  type MediaMetaMsg,
} from '@webrtc-gomoku/shared';

import type { TransferProgress } from './mediaSender';
import type { MediaChannelPort } from './mediaChannel';

export interface ReceiverHandlers {
  /** 自动接收（<50MB），会话开始 */
  onStart?: (meta: MediaMetaMsg) => void;
  /** 需要用户确认（≥50MB），调用方决定 accept/reject */
  onRequest?: (meta: MediaMetaMsg) => void;
  onProgress?: (id: string, progress: TransferProgress) => void;
  onComplete?: (result: { meta: MediaMetaMsg; blob: Blob }) => void;
  onFailed?: (id: string, reason: string) => void;
  onCancelledByRemote?: (id: string) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
  timeoutCheckIntervalMs?: number;
}

interface Session {
  meta: MediaMetaMsg;
  status: 'awaiting' | 'receiving' | 'completed';
  nextSeq: number;
  parts: Uint8Array[];
  pending: Map<number, Uint8Array>;
  received: number;
  bytes: number;
  lastProgressAt: number;
  /** 分片已全部到齐但用户尚未确认 */
  ended: boolean;
}

export class MediaReceiver {
  private readonly sessions = new Map<string, Session>();
  private timerId: number | null = null;

  constructor(
    private readonly channel: MediaChannelPort,
    private readonly handlers: ReceiverHandlers = {},
  ) {}

  /** 网络层入口：media-* 帧统一委托到这里（非媒体帧忽略） */
  handle(msg: GameMessage): void {
    this.checkTimeouts();
    switch (msg.t) {
      case 'media-meta':
        this.onMeta(msg);
        break;
      case 'media-chunk':
        this.onChunk(msg);
        break;
      case 'media-end':
        this.onEnd(msg.id);
        break;
      case 'media-cancel':
        this.onCancel(msg.id);
        break;
      default:
        break;
    }
  }

  /** 接受大文件传输 */
  accept(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'awaiting') return;
    session.status = 'receiving';
    session.lastProgressAt = (this.handlers.now ?? Date.now)();
    this.channel.send({ t: 'media-ack', id, ok: true, reason: 'accepted' });
    this.handlers.onStart?.(session.meta);
    if (session.ended) void this.finish(id);
  }

  /** 拒绝大文件传输（通知对端取消） */
  reject(id: string, reason: 'rejected-size' | 'rejected-type' | 'unsupported'): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (this.sessions.size === 0) this.stopTimer();
    this.channel.send({ t: 'media-ack', id, ok: false, reason });
    this.channel.send({ t: 'media-cancel', id });
    this.handlers.onFailed?.(id, reason);
  }

  /** 取消接收会话（清空本地缓冲并通知对端） */
  cancel(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (this.sessions.size === 0) this.stopTimer();
    this.channel.send({ t: 'media-cancel', id });
    this.handlers.onFailed?.(id, 'aborted');
  }

  /** 断线/换房清理：所有未完成会话立即失败，避免无限等待 */
  reset(): void {
    for (const [id, session] of this.sessions) {
      if (session.status !== 'completed') this.handlers.onFailed?.(id, 'channel-closed');
    }
    this.sessions.clear();
    this.stopTimer();
  }

  /** 当前会话数（诊断用） */
  size(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------- 内部

  private startTimer(): void {
    if (this.timerId !== null) return;
    const interval = this.handlers.timeoutCheckIntervalMs ?? 1000;
    const setFn = this.handlers.setInterval ?? globalThis.setInterval;
    this.timerId = setFn(() => this.checkTimeouts(), interval) as unknown as number;
  }

  private stopTimer(): void {
    if (this.timerId === null) return;
    const clearFn = this.handlers.clearInterval ?? globalThis.clearInterval;
    clearFn(this.timerId);
    this.timerId = null;
  }

  private onMeta(meta: MediaMetaMsg): void {
    if (this.sessions.has(meta.id)) return;

    // 1. 先严格校验分片和大小参数范围，避免非法分片参数（如 chunkSize=0）在 planChunks 抛未捕获异常
    const validChunkSize =
      typeof meta.chunkSize === 'number' &&
      meta.chunkSize >= MEDIA_CHUNK_SIZE.MIN &&
      meta.chunkSize <= MEDIA_CHUNK_SIZE.MAX;
    const validSize =
      typeof meta.size === 'number' &&
      meta.size >= 0 &&
      meta.size <= MEDIA_MAX_BYTES;

    if (!validChunkSize || !validSize) {
      this.channel.send({ t: 'media-ack', id: meta.id, ok: false, reason: 'rejected-type' });
      this.channel.send({ t: 'media-cancel', id: meta.id });
      this.handlers.onFailed?.(meta.id, 'invalid-meta');
      return;
    }

    // 2. 清洗文件名并执行接收端安全校验（扩展名黑名单、MIME 与扩展名一致性等）
    const safeName = meta.name ? sanitizeFileName(meta.name) : undefined;
    const payloadCheck = validateFilePayload({
      name: safeName ?? 'attachment.bin',
      mime: meta.mime,
      size: meta.size,
      chunkSize: meta.chunkSize,
    });
    if (!payloadCheck.ok) {
      this.channel.send({ t: 'media-ack', id: meta.id, ok: false, reason: 'rejected-type' });
      this.channel.send({ t: 'media-cancel', id: meta.id });
      this.handlers.onFailed?.(meta.id, payloadCheck.reason);
      return;
    }

    // 3. 计算并核对分片数
    const expectedChunks = planChunks(meta.size, meta.chunkSize);
    if (meta.chunks !== expectedChunks || meta.chunks < 1) {
      this.channel.send({ t: 'media-ack', id: meta.id, ok: false, reason: 'rejected-type' });
      this.channel.send({ t: 'media-cancel', id: meta.id });
      this.handlers.onFailed?.(meta.id, 'invalid-meta');
      return;
    }

    const sanitizedMeta: MediaMetaMsg = safeName ? { ...meta, name: safeName } : meta;
    const session: Session = {
      meta: sanitizedMeta,
      status: 'receiving',
      nextSeq: 0,
      parts: [],
      pending: new Map(),
      received: 0,
      bytes: 0,
      lastProgressAt: (this.handlers.now ?? Date.now)(),
      ended: false,
    };
    this.sessions.set(meta.id, session);
    this.startTimer();

    if (meta.size >= MEDIA_AUTO_ACCEPT_BYTES) {
      session.status = 'awaiting';
      this.handlers.onRequest?.(sanitizedMeta);
      return;
    }
    this.channel.send({ t: 'media-ack', id: meta.id, ok: true, reason: 'accepted' });
    this.handlers.onStart?.(sanitizedMeta);
  }

  private onChunk(msg: Extract<GameMessage, { t: 'media-chunk' }>): void {
    const session = this.sessions.get(msg.id);
    if (!session) return;
    // 大文件未确认时（awaiting）提前到达的分片直接丢弃，不缓冲占用内存
    if (session.status === 'awaiting') return;
    if (msg.seq >= session.meta.chunks) return;
    if (session.pending.has(msg.seq)) return;

    let bytes: Uint8Array;
    try {
      bytes = b64urlToBytes(msg.data);
    } catch {
      this.fail(msg.id, 'invalid-meta');
      return;
    }
    // 单分片不得大于声明的 chunkSize（防伪造超大分片撑爆内存）
    if (bytes.length > session.meta.chunkSize) {
      this.fail(msg.id, 'size-mismatch');
      return;
    }

    session.pending.set(msg.seq, bytes);
    while (session.pending.has(session.nextSeq)) {
      const part = session.pending.get(session.nextSeq);
      if (!part) break;
      session.pending.delete(session.nextSeq);
      session.parts.push(part);
      session.received += 1;
      session.bytes += part.length;
      session.nextSeq += 1;
    }
    session.lastProgressAt = (this.handlers.now ?? Date.now)();

    this.handlers.onProgress?.(msg.id, {
      sentChunks: session.received,
      totalChunks: session.meta.chunks,
      bytesSent: session.bytes,
      bytesTotal: session.meta.size,
      bytesPerSec: 0,
      etaMs: null,
    });

    if (session.bytes > session.meta.size) this.fail(msg.id, 'size-mismatch');
  }

  private onEnd(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.status === 'awaiting') {
      // 分片可能已全部到齐，等用户确认后再交付
      session.ended = true;
      return;
    }
    void this.finish(id);
  }

  private async finish(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.received !== session.meta.chunks || session.bytes !== session.meta.size) {
      this.fail(id, 'incomplete');
      return;
    }

    // 完整性校验：若 meta 中声明了 SHA-256 哈希，则校验重组后数据的哈希
    if (session.meta.hash) {
      try {
        const total = new Uint8Array(session.bytes);
        let offset = 0;
        for (const part of session.parts) {
          total.set(part, offset);
          offset += part.length;
        }
        const actualHash = await computeSha256(total);
        if (this.sessions.get(id) !== session) return;

        if (actualHash.toLowerCase() !== session.meta.hash.toLowerCase()) {
          this.channel.send({ t: 'media-ack', id, ok: false, reason: 'rejected-type' });
          this.fail(id, 'hash-mismatch');
          return;
        }
      } catch {
        if (this.sessions.get(id) !== session) return;
        this.channel.send({ t: 'media-ack', id, ok: false, reason: 'rejected-type' });
        this.fail(id, 'hash-mismatch');
        return;
      }
    }

    const blob = new Blob(session.parts as BlobPart[], { type: session.meta.mime || 'application/octet-stream' });
    session.status = 'completed';
    this.sessions.delete(id);
    if (this.sessions.size === 0) this.stopTimer();
    this.channel.send({ t: 'media-ack', id, ok: true, reason: 'done' });
    this.handlers.onComplete?.({ meta: session.meta, blob });
  }

  private onCancel(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (this.sessions.size === 0) this.stopTimer();
    this.handlers.onCancelledByRemote?.(id);
  }

  private fail(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (this.sessions.size === 0) this.stopTimer();
    this.channel.send({ t: 'media-cancel', id });
    this.handlers.onFailed?.(id, reason);
  }

  private checkTimeouts(): void {
    const now = (this.handlers.now ?? Date.now)();
    for (const [id, session] of Array.from(this.sessions.entries())) {
      if (session.status === 'completed') continue;
      const timeoutLimit = session.status === 'awaiting' ? MEDIA_CONFIRM_TIMEOUT_MS : MEDIA_PROGRESS_TIMEOUT_MS;
      if (now - session.lastProgressAt > timeoutLimit) {
        this.fail(id, 'timeout');
      }
    }
  }
}
