/**
 * 富媒体聊天控制器（React 接线层）。
 *
 * 职责：
 * - 能力交集（入口显隐唯一判据）；
 * - 发送图片/文件/语音，维护传输进度气泡与 objectURL 生命周期；
 * - 接收侧接线（MediaReceiver → ChatItem），大文件确认、失败/取消收敛。
 *
 * App 只负责把依赖注入进来，不再散落传输细节（保持 App.tsx 行数 ratchet）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Capabilities, GameMessage } from '@webrtc-gomoku/shared';
import {
  ALL_CAPABILITIES_OFF,
  MEDIA_LARGE_HINT_BYTES,
  detectRenderKind,
  formatBytes,
  makeMediaId,
  negotiateCapabilities,
  normalizeCapabilities,
  sanitizeFileName,
  validateFilePayload,
} from '@webrtc-gomoku/shared';

import type { ChatItem, ModalState } from '../types';
import { sounds } from '../audio';
import type { ConnectionApi } from '../connection/useConnection';
import { localCapabilities } from './capabilities';
import { chatTime, createTransferItem } from './chatItems';
import { largeFileConfirmText, rejectText, transferFailText } from './copy';
import type { MediaChannelPort } from './mediaChannel';
import { MediaReceiver, type ReceiverHandlers } from './mediaReceiver';
import { sendMediaBlob } from './mediaSender';
import { VoiceRecorder } from './voiceRecorder';

/** 传给 Chat 组件的媒体能力与动作 */
export interface ChatMediaApi {
  capabilities: Capabilities;
  recording: { active: boolean; elapsedMs: number };
  onSendFile: (kind: 'image' | 'file', file: File) => void;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onCancelRecord: () => void;
  onCancelTransfer: (mediaId: string) => void;
}

export interface UseChatMediaOptions {
  connRef: { current: ConnectionApi | null };
  setMessages: Dispatch<SetStateAction<ChatItem[]>>;
  setModal: (value: ModalState | ((prev: ModalState) => ModalState)) => void;
  showToast: (message: string) => void;
  addSysMsg: (text: string) => void;
  connected: boolean;
}

export interface ChatMediaController extends ChatMediaApi {
  /** 网络层媒体帧入口（onlineMessages 委托） */
  handleFrame: (msg: GameMessage) => void;
  /** hello 携带的对手能力集 */
  setPeerCapabilities: (caps: Capabilities) => void;
  /** 断线/换房：所有进行中的传输立即失败，不无限等待 */
  failAll: () => void;
  /** 清理所有由本控制器创建的 Blob URL（换房/重置时调用，防止内存泄漏） */
  revokeAllUrls: () => void;
  peerCapabilities: Capabilities | null;
}

/** 本地等待回执或本地终止事件（取消/断线/超时）的内部收敛结果类型 */
export interface LocalAckResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export function useChatMedia(options: UseChatMediaOptions): ChatMediaController {
  const { connRef, setMessages, setModal, showToast, addSysMsg, connected } = options;

  const local = localCapabilities();
  const [peerCaps, setPeerCaps] = useState<Capabilities | null>(null);
  const [recording, setRecording] = useState({ active: false, elapsedMs: 0 });

  const abortedRef = useRef<Set<string>>(new Set());
  const activeSendsRef = useRef<Set<string>>(new Set());
  const ackWaitersRef = useRef<Map<string, (result: LocalAckResult) => void>>(new Map());
  const urlsRef = useRef<Set<string>>(new Set());
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const receiverRef = useRef<MediaReceiver | null>(null);
  const sendFileRef = useRef<(kind: 'image' | 'file' | 'audio', file: File, durationMs?: number) => Promise<void>>(
    async () => {},
  );
  const stopRecordingRef = useRef<() => void>(() => {});

  /** 双方能力交集；未收到 hello 前一律全关（入口不渲染） */
  const capabilities: Capabilities = peerCaps
    ? negotiateCapabilities(local, peerCaps)
    : { ...ALL_CAPABILITIES_OFF };

  /** 传输端口：房间模式与手动模式都通过 conn.send / conn.client.dc */
  const channel: MediaChannelPort = {
    isOpen: () => {
      const dc = connRef.current?.client?.dc;
      return !!dc && dc.readyState === 'open';
    },
    send: (msg: GameMessage): boolean => connRef.current?.send(msg) ?? false,
    bufferedAmount: () => connRef.current?.client?.dc?.bufferedAmount ?? 0,
    onClose: () => {
      /* 断线统一由 App 调 failAll 收敛 */
    },
  };

  const updateTransfer = useCallback(
    (mediaId: string, patch: Partial<Extract<ChatItem, { kind: 'transfer' }>>) => {
      setMessages((prev) =>
        prev.map((item) =>
          item.kind === 'transfer' && item.mediaId === mediaId ? { ...item, ...patch } : item,
        ),
      );
    },
    [setMessages],
  );

  const replaceTransfer = useCallback(
    (mediaId: string, next: ChatItem) => {
      setMessages((prev) =>
        prev.map((item) => (item.kind === 'transfer' && item.mediaId === mediaId ? next : item)),
      );
    },
    [setMessages],
  );

  const makeUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    urlsRef.current.add(url);
    return url;
  }, []);

  /** 接收器回调代理：始终调用最新闭包（receiver 只创建一次，保住进行中的会话） */
  const receiverHandlersRef = useRef<ReceiverHandlers>({});
  receiverHandlersRef.current = {
    onStart: (meta) => {
      setMessages((prev) => [
        ...prev,
        createTransferItem({
          sender: 'peer',
          mediaId: meta.id,
          direction: 'receive',
          name: meta.name,
          size: meta.size,
          status: 'receiving',
        }),
      ]);
      if (meta.size > MEDIA_LARGE_HINT_BYTES) {
        addSysMsg('大文件传输中，建议双方处于同一局域网或使用 IPv6');
      }
    },
    onRequest: (meta) => {
      setModal({
        open: true,
        title: '接收文件确认',
        text: largeFileConfirmText(meta.name, formatBytes(meta.size)),
        onOk: () => {
          setModal((m) => ({ ...m, open: false }));
          receiverRef.current?.accept(meta.id);
        },
        onNo: () => {
          setModal((m) => ({ ...m, open: false }));
          receiverRef.current?.reject(meta.id, 'rejected-size');
        },
      });
    },
    onProgress: (id, p) => updateTransfer(id, { done: p.bytesSent }),
    onComplete: ({ meta, blob }) => {
      const kind = detectRenderKind(meta.kind, meta.name, meta.mime);
      const base = {
        id: Math.random().toString(36).slice(2),
        sender: 'peer' as const,
        time: chatTime(),
        mediaId: meta.id,
      };
      const item: ChatItem =
        kind === 'image'
          ? { ...base, kind: 'image', url: makeUrl(blob), name: meta.name, size: meta.size }
          : kind === 'audio'
            ? { ...base, kind: 'audio', url: makeUrl(blob), durationMs: meta.durationMs ?? 0 }
            : { ...base, kind: 'file', url: makeUrl(blob), name: meta.name, size: meta.size, mime: meta.mime };
      replaceTransfer(meta.id, item);
      sounds.playNotify();
    },
    onFailed: (id, reason) => {
      updateTransfer(id, { status: 'failed' });
      addSysMsg(transferFailText(reason));
    },
    onCancelledByRemote: (id) => {
      updateTransfer(id, { status: 'cancelled' });
      addSysMsg('对方取消了传输');
    },
  };

  if (!receiverRef.current) {
    receiverRef.current = new MediaReceiver(channel, {
      onStart: (m) => receiverHandlersRef.current.onStart?.(m),
      onRequest: (m) => receiverHandlersRef.current.onRequest?.(m),
      onProgress: (id, p) => receiverHandlersRef.current.onProgress?.(id, p),
      onComplete: (r) => receiverHandlersRef.current.onComplete?.(r),
      onFailed: (id, reason) => receiverHandlersRef.current.onFailed?.(id, reason),
      onCancelledByRemote: (id) => receiverHandlersRef.current.onCancelledByRemote?.(id),
    });
  }

  const sendFile = useCallback(
    async (kind: 'image' | 'file' | 'audio', file: File, durationMs?: number): Promise<void> => {
      if (!connected) {
        showToast('请先连接对手');
        return;
      }
      const checked = validateFilePayload({ name: file.name, mime: file.type, size: file.size });
      if (!checked.ok) {
        showToast(rejectText(checked.reason));
        return;
      }

      const renderKind = detectRenderKind(kind, file.name, file.type);
      const id = makeMediaId();
      const name = sanitizeFileName(file.name, kind === 'audio' ? '语音消息' : '未命名文件');
      const mime = file.type || 'application/octet-stream';
      abortedRef.current.delete(id);
      activeSendsRef.current.add(id);

      setMessages((prev) => [
        ...prev,
        createTransferItem({
          sender: 'self',
          mediaId: id,
          direction: 'send',
          name,
          size: file.size,
          status: 'sending',
        }),
      ]);

      const waitForAck = (expected: 'accepted' | 'done'): Promise<{ ok: boolean; reason?: string }> => {
        return new Promise<{ ok: boolean; reason?: string }>((resolve) => {
          if (abortedRef.current.has(id)) {
            resolve({ ok: false, reason: 'aborted' });
            return;
          }
          const timeoutMs = expected === 'accepted' ? 60_000 : 15_000;
          let timer: number | null = null;

          const cleanup = () => {
            if (timer !== null) clearTimeout(timer);
            ackWaitersRef.current.delete(id);
          };

          timer = setTimeout(() => {
            cleanup();
            resolve({ ok: false, reason: 'timeout' });
          }, timeoutMs) as unknown as number;

          ackWaitersRef.current.set(id, (ack) => {
            if (expected === 'accepted') {
              if (ack.ok && ack.reason === 'accepted') {
                cleanup();
                resolve({ ok: true, reason: 'accepted' });
              } else if (!ack.ok) {
                cleanup();
                resolve({ ok: false, reason: ack.reason });
              }
            } else if (expected === 'done') {
              if (ack.ok && ack.reason === 'done') {
                cleanup();
                resolve({ ok: true, reason: 'done' });
              } else if (!ack.ok) {
                cleanup();
                resolve({ ok: false, reason: ack.reason });
              }
            }
          });
        });
      };

      const outcome = await sendMediaBlob({
        blob: file,
        name,
        mime,
        kind: renderKind,
        channel,
        id,
        durationMs,
        shouldAbort: () => abortedRef.current.has(id),
        onProgress: (p) => updateTransfer(id, { done: p.bytesSent }),
        waitForAck,
      });

      activeSendsRef.current.delete(id);
      if (outcome.status === 'done') {
        const base = {
          id: Math.random().toString(36).slice(2),
          sender: 'self' as const,
          time: chatTime(),
          mediaId: id,
        };
        const item: ChatItem =
          renderKind === 'image'
            ? { ...base, kind: 'image', url: makeUrl(file), name, size: file.size }
            : renderKind === 'audio'
              ? { ...base, kind: 'audio', url: makeUrl(file), durationMs: durationMs ?? 0 }
              : { ...base, kind: 'file', url: makeUrl(file), name, size: file.size, mime };
        replaceTransfer(id, item);
        return;
      }
      if (outcome.status === 'cancelled') {
        updateTransfer(id, { status: 'cancelled' });
        return;
      }
      updateTransfer(id, { status: 'failed' });
      addSysMsg(transferFailText(outcome.reason));
    },
    [connected, showToast, channel, setMessages, updateTransfer, replaceTransfer, makeUrl, addSysMsg],
  );
  sendFileRef.current = sendFile;

  const stopRecording = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecording({ active: false, elapsedMs: 0 });
    try {
      const result = await recorder.stop();
      const file = new File([result.blob], `语音消息-${Date.now()}.webm`, {
        type: result.mime || 'audio/webm',
      });
      await sendFileRef.current('audio', file, result.durationMs);
    } catch (err) {
      showToast('录音失败：' + (err as Error).message);
    }
  }, [showToast]);
  stopRecordingRef.current = () => {
    void stopRecording();
  };

  const startRecording = useCallback(async (): Promise<void> => {
    if (!connected) {
      showToast('请先连接对手');
      return;
    }
    if (!capabilities.audio) {
      showToast('对方或当前浏览器不支持语音消息');
      return;
    }
    if (recorderRef.current) return;
    const recorder = new VoiceRecorder();
    recorder.onTick = (ms) => setRecording({ active: true, elapsedMs: ms });
    recorder.onAutoStop = () => stopRecordingRef.current();
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setRecording({ active: true, elapsedMs: 0 });
    } catch (err) {
      recorderRef.current = null;
      setRecording({ active: false, elapsedMs: 0 });
      showToast('无法开始录音：' + (err as Error).message);
    }
  }, [connected, capabilities.audio, showToast]);

  const cancelRecording = useCallback((): void => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecording({ active: false, elapsedMs: 0 });
  }, []);

  const cancelTransfer = useCallback(
    (mediaId: string): void => {
      abortedRef.current.add(mediaId);
      const waiter = ackWaitersRef.current.get(mediaId);
      if (waiter) {
        waiter({ ok: false, reason: 'aborted' });
      }
      activeSendsRef.current.delete(mediaId);
      receiverRef.current?.cancel(mediaId);
      channel.send({ t: 'media-cancel', id: mediaId });
      updateTransfer(mediaId, { status: 'cancelled' });
    },
    [channel, updateTransfer],
  );

  const handleFrame = useCallback((msg: GameMessage): void => {
    if (msg.t === 'media-ack') {
      const waiter = ackWaitersRef.current.get(msg.id);
      if (waiter) {
        waiter({ ok: msg.ok, reason: msg.reason });
      }
      return;
    }
    if (msg.t === 'media-cancel') {
      abortedRef.current.add(msg.id);
      const waiter = ackWaitersRef.current.get(msg.id);
      if (waiter) {
        waiter({ ok: false, reason: 'remote-cancelled' });
      }
      receiverRef.current?.handle(msg);
      return;
    }
    receiverRef.current?.handle(msg);
  }, []);

  const setPeerCapabilities = useCallback((caps: Capabilities): void => {
    setPeerCaps(normalizeCapabilities(caps));
  }, []);

  const failAll = useCallback((): void => {
    receiverRef.current?.reset();
    for (const [, waiter] of ackWaitersRef.current) {
      waiter({ ok: false, reason: 'channel-closed' });
    }
    ackWaitersRef.current.clear();
    for (const id of activeSendsRef.current) abortedRef.current.add(id);
    activeSendsRef.current.clear();
    setMessages((prev) =>
      prev.map((item) =>
        item.kind === 'transfer' && (item.status === 'sending' || item.status === 'receiving')
          ? { ...item, status: 'failed' as const }
          : item,
      ),
    );
  }, [setMessages]);

  const revokeAllUrls = useCallback((): void => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);

  // 卸载清理：停止录音、回收 objectURL
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      for (const [, waiter] of ackWaitersRef.current) {
        waiter({ ok: false, reason: 'aborted' });
      }
      ackWaitersRef.current.clear();
      receiverRef.current?.reset();
      receiverRef.current = null;
      revokeAllUrls();
    },
    [revokeAllUrls],
  );

  return {
    capabilities,
    recording,
    onSendFile: (kind, file) => {
      void sendFile(kind, file);
    },
    onStartRecord: () => {
      void startRecording();
    },
    onStopRecord: () => {
      void stopRecording();
    },
    onCancelRecord: cancelRecording,
    onCancelTransfer: cancelTransfer,
    handleFrame,
    setPeerCapabilities,
    failAll,
    revokeAllUrls,
    peerCapabilities: peerCaps,
  };
}
