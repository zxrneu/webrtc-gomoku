import type { Dispatch, SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatMedia, type UseChatMediaOptions } from '../../src/media/useChatMedia';
import { sendMediaBlob } from '../../src/media/mediaSender';
import type { RecordResult } from '../../src/media/voiceRecorder';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
const voice = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(), stop: vi.fn<() => Promise<RecordResult>>(), cancel: vi.fn(),
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.slots[index] as T, value => {
      hooks.slots[index] = typeof value === 'function'
        ? (value as (previous: T) => T)(hooks.slots[index] as T) : value;
    }];
  },
  useRef<T>(initial: T): { current: T } {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index] as { current: T };
  },
  useCallback<T>(callback: T): T { return callback; },
  useEffect() {},
}));
vi.mock('../../src/media/capabilities', () => ({
  localCapabilities: () => ({ qr: true, file: true, audio: true, video: false }),
  voiceMessageUnavailableReason: () => undefined,
}));
vi.mock('../../src/media/voiceRecorder', () => ({
  VoiceRecorder: class { start = voice.start; stop = voice.stop; cancel = voice.cancel; },
}));
vi.mock('../../src/media/mediaSender', () => ({ sendMediaBlob: vi.fn(async () => ({ status: 'done' })) }));

const result = (): RecordResult => ({ blob: new Blob(['voice']), mime: 'audio/webm', durationMs: 1000 });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function setup() {
  const options: UseChatMediaOptions = {
    connected: true, connRef: { current: null }, setMessages: vi.fn(), setModal: vi.fn(),
    showToast: vi.fn(), addSysMsg: vi.fn(),
  };
  const render = () => { hooks.cursor = 0; return useChatMedia(options); };
  render().setPeerCapabilities({ qr: true, file: true, audio: true, video: false });
  return { render, options };
}
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0;
  vi.clearAllMocks();
  voice.start.mockResolvedValue(undefined); voice.stop.mockResolvedValue(result());
});

describe('语音消息会话隔离', () => {
  it('换房清理会取消当前录音，不能向新对手发送', async () => {
    const { render } = setup();
    render().onStartRecord(); await flush();
    render().failAll(); render().revokeAllUrls();
    render().onStopRecord(); await flush();
    expect(voice.cancel).toHaveBeenCalledOnce();
    expect(render().recording.active).toBe(false);
    expect(sendMediaBlob).not.toHaveBeenCalled();
  });

  it('换房后迟到的录音启动不能重新显示录音状态', async () => {
    let resolve!: () => void;
    voice.start.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { render } = setup();
    render().onStartRecord(); render().failAll();
    resolve(); await flush();
    expect(render().recording.active).toBe(false);
    expect(sendMediaBlob).not.toHaveBeenCalled();
  });

  it('等待录音结果时换房，旧结果不能发送给新对手', async () => {
    let resolve!: (value: RecordResult) => void;
    voice.stop.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { render } = setup();
    render().onStartRecord(); await flush();
    render().onStopRecord(); render().failAll();
    resolve(result()); await flush();
    expect(sendMediaBlob).not.toHaveBeenCalled();
  });

  it('同一会话停止录音后仍正常发送语音消息', async () => {
    const { render } = setup();
    render().onStartRecord(); await flush();
    render().onStopRecord(); await flush();
    expect(sendMediaBlob).toHaveBeenCalledOnce();
    expect(render().recording.active).toBe(false);
  });
});
