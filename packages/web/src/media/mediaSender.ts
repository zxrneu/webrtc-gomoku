/**
 * 富媒体发送器：meta → 分片循环（流控 + 让出事件循环）→ end。
 *
 * 所有 IO 通过参数注入（channel / sleep / yieldLoop / now / shouldAbort），
 * 单测用假通道即可确定步进，不依赖真实网络。
 */
import {
  MEDIA_CHUNK_SIZE,
  MEDIA_FLOW_CONTROL,
  bytesToB64url,
  computeSha256,
  makeMediaId,
  planChunks,
  type GameMessage,
  type MediaKind,
} from '@webrtc-gomoku/shared';

import { chunkRanges } from './chunker';
import type { MediaChannelPort } from './mediaChannel';

/** 发送进度（接收侧复用同一结构，bytesSent 表示已收字节） */
export interface TransferProgress {
  readonly sentChunks: number;
  readonly totalChunks: number;
  readonly bytesSent: number;
  readonly bytesTotal: number;
  readonly bytesPerSec: number;
  readonly etaMs: number | null;
}

export type SendOutcome =
  | { status: 'done' }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: 'channel-closed' | 'send-error' | 'aborted' | string };

export interface SendMediaOptions {
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
  readonly kind: MediaKind;
  readonly channel: MediaChannelPort;
  readonly id?: string;
  readonly chunkSize?: number;
  /** 语音消息时长（毫秒），随 meta 下发 */
  readonly durationMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly yieldLoop?: () => Promise<void>;
  readonly now?: () => number;
  readonly onProgress?: (p: TransferProgress) => void;
  /** 取消信号（每个分片前检查） */
  readonly shouldAbort?: () => boolean;
  /**
   * 等待对端的确认回执（'accepted' 或 'done'）。
   * - 发送 meta 后等待 'accepted'（若对端拒绝或超时，立即终止并不发送分片）；
   * - 发送 end 后等待 'done'（收到接收端重组完成确认后才标记传输成功）。
   */
  readonly waitForAck?: (expectedReason: 'accepted' | 'done') => Promise<{ ok: boolean; reason?: string }>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 发送一个 Blob（图片/文件/语音）。
 *
 * @returns 收敛结果；取消时已向对端发送 `media-cancel`
 */
export async function sendMediaBlob(options: SendMediaOptions): Promise<SendOutcome> {
  const {
    blob,
    name,
    mime,
    kind,
    channel,
    durationMs,
    onProgress,
    shouldAbort,
    waitForAck,
  } = options;
  const id = options.id ?? makeMediaId();
  const chunkSize = options.chunkSize ?? MEDIA_CHUNK_SIZE.DEFAULT;
  const sleep = options.sleep ?? defaultSleep;
  const yieldLoop = options.yieldLoop ?? (() => defaultSleep(0));
  const now = options.now ?? Date.now;

  const bytesTotal = blob.size;
  const totalChunks = planChunks(bytesTotal, chunkSize);
  const ranges = chunkRanges(bytesTotal, chunkSize);
  const startedAt = now();
  let bytesSent = 0;
  let sentChunks = 0;

  const aborted = (): boolean => shouldAbort?.() === true;
  const cancel = (): SendOutcome => {
    channel.send({ t: 'media-cancel', id });
    return { status: 'cancelled' };
  };

  if (!channel.isOpen()) return { status: 'failed', reason: 'channel-closed' };

  // 计算数据的完整 SHA-256 哈希
  let hash: string | undefined;
  try {
    const arrayBuf = await blob.arrayBuffer();
    hash = await computeSha256(new Uint8Array(arrayBuf));
  } catch {
    // 降级：环境无法计算哈希时忽略
  }

  if (aborted()) return cancel();

  const metaOk = channel.send({
    t: 'media-meta',
    id,
    kind,
    name,
    size: bytesTotal,
    mime,
    chunkSize,
    chunks: totalChunks,
    ...(hash ? { hash } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  } satisfies GameMessage);
  if (!metaOk) return { status: 'failed', reason: 'channel-closed' };

  // 若提供了 waitForAck，则在发送分片前等待对端确认接收（例如大文件确认）
  if (waitForAck) {
    const ack = await waitForAck('accepted');
    if (aborted()) return cancel();
    if (!ack.ok) {
      return { status: 'failed', reason: ack.reason ?? 'rejected' };
    }
  }

  for (const range of ranges) {
    if (aborted()) return cancel();

    // 流控：缓冲过高时等待回落，避免把主通道灌满导致落子消息排队
    while (channel.bufferedAmount() > MEDIA_FLOW_CONTROL.PAUSE_ABOVE) {
      if (aborted()) return cancel();
      await sleep(MEDIA_FLOW_CONTROL.POLL_MS);
    }

    const part = blob.slice(range.start, range.end);
    const bytes = new Uint8Array(await part.arrayBuffer());
    const ok = channel.send({ t: 'media-chunk', id, seq: range.seq, data: bytesToB64url(bytes) });
    if (!ok) return { status: 'failed', reason: 'send-error' };

    bytesSent += bytes.length;
    sentChunks += 1;

    if (onProgress) {
      const elapsedSec = Math.max((now() - startedAt) / 1000, 0.001);
      const rate = bytesSent / elapsedSec;
      const remaining = bytesTotal - bytesSent;
      onProgress({
        sentChunks,
        totalChunks,
        bytesSent,
        bytesTotal,
        bytesPerSec: rate,
        etaMs: rate > 0 ? Math.round((remaining / rate) * 1000) : null,
      });
    }

    // 每个分片后让出事件循环：保证落子/聊天不被大文件传输卡住（R4/G2）
    await yieldLoop();
  }

  if (aborted()) return cancel();
  if (!channel.send({ t: 'media-end', id })) return { status: 'failed', reason: 'send-error' };

  // 发送完毕后等待接收端校验并确认（done）
  if (waitForAck) {
    const doneAck = await waitForAck('done');
    if (aborted()) return cancel();
    if (!doneAck.ok) {
      return { status: 'failed', reason: doneAck.reason ?? 'send-error' };
    }
  }

  return { status: 'done' };
}
