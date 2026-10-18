/**
 * 人机设置的本地持久化（PRD P1-3）。
 *
 * 三条硬约束：
 * 1. 默认值固定为「最强 + 执黑」（首次访问的体验基线）；
 * 2. **任何异常都不许冒泡**：隐私模式 / 存储被禁用 / 配额满 / 值被手改成脏数据，
 *    一律降级为默认值，绝不让「存不了设置」变成「进不去游戏」；
 * 3. 读写都不依赖 `window` 存在（单测跑在 node 环境，无 DOM）。
 */

import type { Difficulty, PlayerColor } from '@webrtc-gomoku/core';
import { BLACK, WHITE } from '@webrtc-gomoku/core';

/** 默认难度：最强（PRD §4 P0 只交付「最强」一档） */
export const DEFAULT_DIFFICULTY: Difficulty = 'hard';

/** 默认执子：黑（先手，老用户习惯） */
export const DEFAULT_PLAYER_COLOR: PlayerColor = BLACK;

/** 难度存储键 */
const DIFFICULTY_KEY = 'gomoku.ai.difficulty';

/** 执子存储键 */
const COLOR_KEY = 'gomoku.ai.playerColor';

/** 一份完整的人机设置 */
export interface AiSettings {
  readonly difficulty: Difficulty;
  readonly playerColor: PlayerColor;
}

/** 默认设置（冻结，防止调用点误改） */
export const DEFAULT_AI_SETTINGS: AiSettings = Object.freeze({
  difficulty: DEFAULT_DIFFICULTY,
  playerColor: DEFAULT_PLAYER_COLOR,
});

/**
 * 取可用的 localStorage；不可用时返回 null（不抛）。
 *
 * 注意：某些浏览器在「禁用第三方存储」时，**访问** `localStorage` 属性本身就会抛异常，
 * 所以取值必须包在 try 里，而不是只包住 getItem。
 */
function safeStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** 难度取值校验（把任意字符串收窄为 `Difficulty`，避免 `as` 滥用） */
export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

/** 执子取值校验（存储里是字符串，转回 core 的 1/2） */
function parseColor(value: unknown): PlayerColor | null {
  if (value === String(BLACK)) return BLACK;
  if (value === String(WHITE)) return WHITE;
  return null;
}

/** 安全读取一个键；任何异常返回 null */
function readKey(key: string): string | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** 安全写入一个键；任何异常静默忽略 */
function writeKey(key: string, value: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // 配额满 / 隐私模式：设置存不下不影响当前对局，直接放弃
  }
}

/**
 * 读取人机设置；缺省或脏数据一律回落到默认值。
 * @returns 一定合法的设置对象
 */
export function loadAiSettings(): AiSettings {
  const rawDifficulty = readKey(DIFFICULTY_KEY);
  const rawColor = readKey(COLOR_KEY);
  const difficulty = isDifficulty(rawDifficulty) ? rawDifficulty : DEFAULT_DIFFICULTY;
  const playerColor = parseColor(rawColor) ?? DEFAULT_PLAYER_COLOR;
  return { difficulty, playerColor };
}

/**
 * 持久化难度选择。
 * @param difficulty 用户选择的档位
 */
export function saveDifficulty(difficulty: Difficulty): void {
  writeKey(DIFFICULTY_KEY, difficulty);
}

/**
 * 持久化执子选择。
 * @param color 用户选择的颜色
 */
export function savePlayerColor(color: PlayerColor): void {
  writeKey(COLOR_KEY, String(color));
}
