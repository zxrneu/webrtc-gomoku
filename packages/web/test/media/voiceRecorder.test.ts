import { describe, expect, it, vi } from 'vitest';
import { VOICE_MAX_MS } from '@webrtc-gomoku/shared';

import { VoiceRecorder, isVoiceRuntimeSupported, pickAudioMime } from '../../src/media/voiceRecorder';

/** 假 MediaRecorder：stop() 时先给一块数据再触发 onstop */
class FakeMediaRecorder {
  static isTypeSupported = (mime: string): boolean => mime === 'audio/webm';

  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    if (options?.mimeType) this.mimeType = options.mimeType;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') {
      throw new Error("Failed to execute 'stop' on 'MediaRecorder': The MediaRecorder's state is 'inactive'.");
    }
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['voice-bytes']) });
      this.onstop?.();
    });
  }
}

function makeEnv(over: { now?: () => number; intervals?: (() => void)[]; stopped?: string[] } = {}) {
  const intervals: (() => void)[] = over.intervals ?? [];
  const stopped = over.stopped ?? [];
  const stream = { getTracks: () => [{ stop: () => stopped.push('track') }] };
  return {
    env: {
      mediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
      getUserMedia: async () => stream as unknown as MediaStream,
      now: over.now ?? (() => 0),
      setInterval: (fn: () => void) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: () => {},
    },
    intervals,
    stopped,
  };
}

describe('pickAudioMime', () => {
  it('取第一个受支持的候选', () => {
    expect(pickAudioMime(['audio/a', 'audio/b'], (m) => m === 'audio/b')).toBe('audio/b');
  });

  it('都不支持返回 null', () => {
    expect(pickAudioMime(['audio/a'], () => false)).toBeNull();
  });
});

describe('isVoiceRuntimeSupported', () => {
  it('无环境注入（Node 单测）视为不支持', () => {
    expect(isVoiceRuntimeSupported()).toBe(false);
  });

  it('注入 MediaRecorder + getUserMedia 后支持', () => {
    const { env } = makeEnv();
    expect(isVoiceRuntimeSupported(env)).toBe(true);
  });
});

describe('VoiceRecorder', () => {
  it('start → stop 返回音频 Blob 与时长，并释放麦克风轨道', async () => {
    let now = 1000;
    const { env, stopped } = makeEnv({ now: () => now });
    const recorder = new VoiceRecorder(env);

    await recorder.start();
    expect(recorder.isRecording).toBe(true);
    now = 3500;
    const result = await recorder.stop();

    expect(result.mime).toBe('audio/webm');
    expect(result.durationMs).toBe(2500);
    expect(await result.blob.text()).toBe('voice-bytes');
    expect(stopped).toContain('track');
  });

  it('达到 60s 触发 onAutoStop 并停止录音', async () => {
    let now = 0;
    const { env, intervals } = makeEnv({ now: () => now });
    const recorder = new VoiceRecorder(env);
    const onAutoStop = vi.fn();
    recorder.onAutoStop = onAutoStop;
    const ticks: number[] = [];
    recorder.onTick = (ms) => ticks.push(ms);

    await recorder.start();
    now = VOICE_MAX_MS;
    intervals.forEach((tick) => tick());

    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(ticks[ticks.length - 1]).toBe(VOICE_MAX_MS);
    expect(recorder.isRecording).toBe(false);
  });

  it('达到 60s 且由 onAutoStop 调用 stop() 时，能正常解析结果且不重复停止', async () => {
    let now = 0;
    const { env, intervals } = makeEnv({ now: () => now });
    const recorder = new VoiceRecorder(env);
    let resultPromise: Promise<unknown> | null = null;
    recorder.onAutoStop = () => {
      resultPromise = recorder.stop();
    };

    await recorder.start();
    now = VOICE_MAX_MS;
    intervals.forEach((tick) => tick());

    expect(resultPromise).not.toBeNull();
    const result = await (resultPromise as unknown as Promise<{ blob: Blob; durationMs: number }>);
    expect(await result.blob.text()).toBe('voice-bytes');
    expect(recorder.isRecording).toBe(false);
  });

  it('cancel 丢弃录音并释放轨道', async () => {
    const { env, stopped } = makeEnv();
    const recorder = new VoiceRecorder(env);
    await recorder.start();
    recorder.cancel();
    expect(stopped).toContain('track');
    expect(recorder.isRecording).toBe(false);
  });

  it('等待麦克风权限时取消，迟到的授权不会启动录音且释放轨道', async () => {
    const { env, stopped } = makeEnv();
    let grant!: (stream: MediaStream) => void;
    const recorder = new VoiceRecorder({ ...env, getUserMedia: () => new Promise(resolve => { grant = resolve; }) });
    const starting = recorder.start();
    recorder.cancel();
    grant({ getTracks: () => [{ stop: () => stopped.push('late-track') }] } as unknown as MediaStream);
    await starting;
    expect(recorder.isRecording).toBe(false);
    expect(stopped).toContain('late-track');
  });

  it('录音器启动失败时释放已获得的麦克风轨道', async () => {
    const { env, stopped } = makeEnv();
    class BrokenRecorder extends FakeMediaRecorder {
      override start(): void { throw new Error('设备已断开'); }
    }
    const recorder = new VoiceRecorder({ ...env, mediaRecorder: BrokenRecorder as unknown as typeof MediaRecorder });
    await expect(recorder.start()).rejects.toThrow('设备已断开');
    expect(stopped).toContain('track');
    expect(recorder.isRecording).toBe(false);
  });

  it('未开始录音时 stop 抛错', async () => {
    const { env } = makeEnv();
    const recorder = new VoiceRecorder(env);
    await expect(recorder.stop()).rejects.toThrow();
  });

  it('环境不支持时 start 抛错（R3 降级）', async () => {
    const recorder = new VoiceRecorder({ mediaRecorder: undefined, getUserMedia: undefined });
    await expect(recorder.start()).rejects.toThrow(/不支持录音/);
  });
});
