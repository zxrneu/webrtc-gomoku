/**
 * 语音消息录音封装（MediaRecorder + getUserMedia）。
 *
 * 依赖全部可注入（构造器 / getUserMedia / now / 定时器），
 * 单测用假实现即可覆盖 start/stop/cancel/超时，不需要真实麦克风。
 */
import { VOICE_MAX_MS } from '@webrtc-gomoku/shared';

export interface RecordResult {
  blob: Blob;
  mime: string;
  durationMs: number;
}

export interface RecorderEnv {
  mediaRecorder?: typeof MediaRecorder;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
}

/** 候选 MIME 优先级（浏览器支持哪个用哪个） */
const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/** 从候选里挑第一个被支持的 MIME；都不支持返回 null（交给浏览器默认） */
export function pickAudioMime(candidates: readonly string[], isSupported: (mime: string) => boolean): string | null {
  for (const mime of candidates) {
    if (isSupported(mime)) return mime;
  }
  return null;
}

function readEnv(env?: RecorderEnv): Required<Pick<RecorderEnv, 'now' | 'setInterval' | 'clearInterval'>> &
  Pick<RecorderEnv, 'mediaRecorder' | 'getUserMedia'> {
  return {
    mediaRecorder: env?.mediaRecorder ?? (typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined),
    getUserMedia:
      env?.getUserMedia ??
      (typeof navigator !== 'undefined' && navigator.mediaDevices
        ? (c) => navigator.mediaDevices.getUserMedia(c)
        : undefined),
    now: env?.now ?? Date.now,
    setInterval: env?.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms) as unknown as number),
    clearInterval: env?.clearInterval ?? ((h) => globalThis.clearInterval(h)),
  };
}

/** 当前环境能否录音（R3 降级判据：file:// 或旧浏览器可能不支持） */
export function isVoiceRuntimeSupported(env?: RecorderEnv): boolean {
  const resolved = readEnv(env);
  return !!resolved.mediaRecorder && !!resolved.getUserMedia;
}

export class VoiceRecorder {
  private readonly env: ReturnType<typeof readEnv>;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  private timer: number | null = null;
  private cancelled = false;
  private generation = 0;
  private starting = false;
  private mime = '';
  private pending: { resolve: (r: RecordResult) => void; reject: (e: Error) => void } | null = null;

  /** 计时回调（UI 显示 mm:ss） */
  onTick?: (elapsedMs: number) => void;
  /** 达到 60s 自动停止（UI 应自动发送） */
  onAutoStop?: () => void;

  constructor(env?: RecorderEnv) {
    this.env = readEnv(env);
  }

  get isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  /** 申请权限并开始录音 */
  async start(): Promise<void> {
    if (this.recorder || this.starting) throw new Error('录音已在进行中');
    const Ctor = this.env.mediaRecorder;
    const getUserMedia = this.env.getUserMedia;
    if (!Ctor || !getUserMedia) throw new Error('当前浏览器不支持录音');

    const generation = ++this.generation;
    this.starting = true;
    try {
      const stream = await getUserMedia({ audio: true });
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = stream;
      this.begin(stream, Ctor);
    } catch (error) {
      if (generation === this.generation) this.cleanup();
      throw error;
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }

  private begin(stream: MediaStream, Ctor: typeof MediaRecorder): void {
    const mime = pickAudioMime(AUDIO_MIME_CANDIDATES, (m) => {
      const fn = (Ctor as unknown as { isTypeSupported?: (mime: string) => boolean }).isTypeSupported;
      return typeof fn === 'function' ? fn.call(Ctor, m) : false;
    });

    const recorder = mime ? new Ctor(stream, { mimeType: mime }) : new Ctor(stream);
    this.stream = stream;
    this.recorder = recorder;
    this.mime = mime ?? recorder.mimeType ?? 'audio/webm';
    this.chunks = [];
    this.cancelled = false;
    this.startedAt = this.env.now();

    recorder.ondataavailable = (event: BlobEvent): void => {
      if (this.recorder === recorder && event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onstop = (): void => { if (this.recorder === recorder) this.finalize(); };

    recorder.start();
    this.timer = this.env.setInterval(() => this.tick(), 250);
  }

  /** 停止并返回录音结果（未开始录音时抛错） */
  stop(): Promise<RecordResult> {
    if (!this.recorder || this.recorder.state === 'inactive') {
      return Promise.reject(new Error('当前没有进行中的录音'));
    }
    this.clearTimer();
    return new Promise<RecordResult>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.recorder?.stop();
    });
  }

  /** 取消录音（丢弃已录内容） */
  cancel(): void {
    this.generation++;
    this.starting = false;
    this.cancelled = true;
    this.clearTimer();
    const pending = this.pending;
    try {
      this.recorder?.stop();
    } catch {
      // 忽略已经处于停止态的异常
    }
    this.cleanup();
    pending?.reject(new Error('录音已取消'));
  }

  // ---------------------------------------------------------------- 内部

  private tick(): void {
    if (!this.recorder) return;
    const elapsed = this.env.now() - this.startedAt;
    this.onTick?.(elapsed);
    if (elapsed >= VOICE_MAX_MS) {
      this.clearTimer();
      this.onAutoStop?.();
      // 若 onAutoStop 已接管并调用了 stop()，则不要重复触发 stop()
      if (this.isRecording && !this.pending) {
        try {
          this.recorder.stop();
        } catch {
          this.cleanup();
        }
      }
    }
  }

  private finalize(): void {
    const durationMs = Math.max(0, this.env.now() - this.startedAt);
    const mime = this.mime;
    const chunks = this.chunks;
    const cancelled = this.cancelled;
    const pending = this.pending;
    this.cleanup();

    if (cancelled) {
      pending?.reject(new Error('录音已取消'));
      return;
    }
    const blob = new Blob(chunks, { type: mime });
    pending?.resolve({ blob, mime, durationMs });
  }

  private cleanup(): void {
    this.clearTimer();
    this.recorder = null;
    this.pending = null;
    this.chunks = [];
    this.cancelled = false;
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach((track) => track.stop());
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.env.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
