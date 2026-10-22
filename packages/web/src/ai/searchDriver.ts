/**
 * 分片搜索调度器（web 侧驱动）。
 *
 * 为什么需要它：core 的 `AiSession.step(budgetMs)` 是「可中断的一片工作」，
 * 若在 React 事件里 `while (step())` 一把梭，主线程会被连续占用 1s，
 * 表现为 thinking 指示永远上不了屏 + 页面卡死（PRD S2 / P1-2）。
 *
 * 因此这里做三件事：
 * 1. **先让出**：第一次调度推迟到 `setThinking(true)` 那次渲染提交之后（架构 §3.1）；
 * 2. **分片循环**：每片 `sliceMs`（默认 32ms，与 core 的 `DEFAULT_SLICE_MS` 同源）后
 *    用 `setTimeout(0)` 让出，单片远低于 longtask 的 50ms 阈值；
 * 3. **可取消**：返回取消函数，取消后**绝不**再触发 `onDone`，
 *    避免组件卸载 / 切模式 / 悔棋后 AI 的旧结果把新棋局踩掉。
 *
 * 时间源与调度器全部可注入（测试注入假 `now`/假 `schedule`，毫秒级确定性）。
 */

import type {
  AiOptions,
  AiSearchStats,
  GameState,
  PlayerColor,
  Point,
} from '@webrtc-gomoku/core';
import { DEFAULT_SLICE_MS, createSearchSession } from '@webrtc-gomoku/core';

/** 调度器可注入项（全部有默认值，生产代码不传） */
export interface DriverOptions {
  /** 会话工厂注入；Worker 可选择 Rust/WASM，主线程回退保留 TS。 */
  createSession?: typeof createSearchSession;
  /** 单片搜索时长（毫秒），默认取 core 的 `DEFAULT_SLICE_MS`（32） */
  sliceMs?: number;
  /** 时间源，默认 `() => performance.now()`（web 层唯一允许直读 performance 的地方） */
  now?: () => number;
  /** 让出方式，默认 `(cb) => setTimeout(cb, 0)` */
  schedule?: (cb: () => void) => void;
}

/** 默认让出方式：宏任务让出，保证浏览器有机会绘制 thinking 指示 */
function defaultSchedule(cb: () => void): void {
  setTimeout(cb, 0);
}

/**
 * 启动一次分片搜索。
 *
 * @param g 棋局快照（搜索期间不会被修改：core 内部自行重建棋盘）
 * @param color 思考方颜色（人机模式下即 AI 的颜色）
 * @param aiOpts 棋力参数（UI 只传 `difficulty`；`now` 缺省时用调度器的时间源兜底）
 * @param driver 调度注入项（分片时长 / 时间源 / 让出方式）
 * @param onDone 搜索结束回调：`move` 为 null 表示无合法着法（终局或非法输入）
 * @returns 取消函数；调用后不再触发 `onDone`
 */
export function runSearchSharded(
  g: GameState,
  color: PlayerColor,
  aiOpts: AiOptions,
  driver: DriverOptions,
  onDone: (move: Point | null, stats: AiSearchStats) => void,
): () => void {
  const sliceMs = driver.sliceMs ?? DEFAULT_SLICE_MS;
  const now = aiOpts.now ?? driver.now ?? ((): number => performance.now());
  const schedule = driver.schedule ?? defaultSchedule;
  const session = (driver.createSession ?? createSearchSession)(g, color, { ...aiOpts, now });

  let cancelled = false;

  const pump = (): void => {
    if (cancelled) return;
    const pending = session.step(sliceMs);
    // `step` 内部可能同步触发取消（例如注入的 schedule 是同步的），必须再检查一次
    if (cancelled) return;
    if (pending) {
      schedule(pump);
      return;
    }
    onDone(session.result(), session.stats());
  };

  // 首片也走 schedule：让出一次事件循环，thinking 指示先上屏
  schedule(pump);

  return (): void => {
    if (cancelled) return;
    cancelled = true;
    session.abort();
  };
}
