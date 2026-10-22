import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLACK, WHITE } from '@webrtc-gomoku/core';

import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_DIFFICULTY,
  DEFAULT_PLAYER_COLOR,
  isDifficulty,
  loadAiSettings,
  loadAiBackend,
  saveAiBackend,
  saveDifficulty,
  savePlayerColor,
} from '../src/ai/aiStorage';

/**
 * 人机设置持久化（T04 ③）
 *
 * 核心断言只有一句：**存储不可用时也必须能玩**。
 * 隐私模式、禁用第三方存储、配额写满都会让 localStorage 抛异常，
 * 这时唯一正确的行为是「降级为默认值 + 绝不冒泡」。
 */

/** 极简内存版 Storage（只实现用到的两个方法） */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    storage: {
      getItem: (key: string): string | null => map.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        map.set(key, value);
      },
    } as unknown as Storage,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('AI 引擎选择持久化', () => {
  it('未选择时默认 Rust/WASM', () => {
    expect(loadAiBackend('')).toBe('rust-wasm');
  });

  it('选择 TS 后重新读取仍为 TS', () => {
    const { storage } = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    saveAiBackend('ts');
    expect(loadAiBackend('')).toBe('ts');
    saveAiBackend('rust-wasm');
    expect(loadAiBackend('')).toBe('rust-wasm');
  });

  it('有效地址参数优先于已保存选择，无效参数保留保存值', () => {
    const { storage } = memoryStorage({ 'gomoku.ai.backend': 'ts' });
    vi.stubGlobal('localStorage', storage);
    expect(loadAiBackend('?aiEngine=rust-wasm')).toBe('rust-wasm');
    expect(loadAiBackend('?aiEngine=gpu')).toBe('ts');
  });

  it('非法存储值回退 Rust/WASM', () => {
    const { storage } = memoryStorage({ 'gomoku.ai.backend': 'gpu' });
    vi.stubGlobal('localStorage', storage);
    expect(loadAiBackend('')).toBe('rust-wasm');
  });

  it('存储属性读取或写入抛异常均不妨碍选择引擎', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get(): Storage { throw new Error('SecurityError'); },
    });
    expect(loadAiBackend('')).toBe('rust-wasm');
    expect(loadAiBackend('?aiEngine=ts')).toBe('ts');
    expect(() => saveAiBackend('ts')).not.toThrow();
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota exceeded'); },
    });
    expect(loadAiBackend('')).toBe('rust-wasm');
    expect(() => saveAiBackend('ts')).not.toThrow();
  });
});

describe('aiStorage 默认值', () => {
  it('无 localStorage（node / SSR）时降级为「最强 + 执黑」且不抛', () => {
    expect(loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
    expect(DEFAULT_DIFFICULTY).toBe('hard');
    expect(DEFAULT_PLAYER_COLOR).toBe(BLACK);
  });

  it('读取 localStorage 属性本身就抛异常时也不抛', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get(): Storage {
        throw new Error('SecurityError: storage disabled');
      },
    });

    expect(() => loadAiSettings()).not.toThrow();
    expect(loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
    expect(() => saveDifficulty('easy')).not.toThrow();
    expect(() => savePlayerColor(WHITE)).not.toThrow();
  });

  it('getItem / setItem 抛异常时同样降级', () => {
    vi.stubGlobal('localStorage', {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage);

    expect(loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
    expect(() => saveDifficulty('normal')).not.toThrow();
  });
});

describe('aiStorage 读写往返', () => {
  it('存下来的难度与执子能被读回', () => {
    const { storage, map } = memoryStorage();
    vi.stubGlobal('localStorage', storage);

    saveDifficulty('normal');
    savePlayerColor(WHITE);

    expect(map.size).toBe(2);
    expect(loadAiSettings()).toEqual({ difficulty: 'normal', playerColor: WHITE });
  });

  it('脏数据（非法档位 / 非法颜色）回落到默认值', () => {
    const { storage } = memoryStorage({
      'gomoku.ai.difficulty': 'impossible',
      'gomoku.ai.playerColor': '7',
    });
    vi.stubGlobal('localStorage', storage);

    expect(loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('只存了一项时，另一项取默认值', () => {
    const { storage } = memoryStorage({ 'gomoku.ai.difficulty': 'easy' });
    vi.stubGlobal('localStorage', storage);

    expect(loadAiSettings()).toEqual({ difficulty: 'easy', playerColor: BLACK });
  });
});

describe('isDifficulty 收窄', () => {
  it('只接受三档合法值', () => {
    expect(isDifficulty('easy')).toBe(true);
    expect(isDifficulty('normal')).toBe(true);
    expect(isDifficulty('hard')).toBe(true);
    expect(isDifficulty('HARD')).toBe(false);
    expect(isDifficulty(null)).toBe(false);
    expect(isDifficulty(3)).toBe(false);
  });
});
