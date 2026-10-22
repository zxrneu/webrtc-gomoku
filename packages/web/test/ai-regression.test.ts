/**
 * 人机对战回归测试（QA 独立补充，PRD P0-4 / P0-5 / P0-6 + 架构 §5 / §6 / §10.1）
 *
 * 为什么需要这个文件：`useAiGame` 是本次交付里**唯一没有任何行为测试**的模块
 * （`ai-wiring.test.ts` 只做源码结构断言），而竞态与「AI 回合丢失」恰恰只会
 * 在 hook 的 effect 调度里发生。仓库没有 @testing-library / jsdom，
 * 所以这里自带一个**最小 hook 运行时**（只实现 useState / useRef / useCallback /
 * useEffect 的依赖比较与清理语义），用它直接驱动**真实的** `useAiGame`。
 *
 * 运行时的三条保真点（与 React 对齐，否则断言会失真）：
 * 1. `setState` 用 `Object.is` 判等，值没变**不触发重渲染**（React bailout）；
 * 2. effect 只在依赖浅比较变化时才「先 cleanup 再 create」；
 * 3. 重渲染与 effect 提交交替进行，直到不再有 setState（同步收敛）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { GameState, PlayerColor } from '@webrtc-gomoku/core';
import { BLACK, WHITE, currentColor } from '@webrtc-gomoku/core';

import {
  canUndoPair,
  createAiGame,
  isPlayerTurn,
  lastMoveOf,
  playAiMove,
  playPlayerMove,
  stoneCount,
  undoPair,
} from '../src/ai/aiGame';
import type { AiGameApi } from '../src/ai/useAiGame';
import { useAiGame } from '../src/ai/useAiGame';
import * as aiSearch from '../src/ai/aiSearch';
import type { GameMode } from '../src/types';

/* ------------------------------------------------------------------ *
 * 一、最小 hook 运行时（仅覆盖 useAiGame 用到的四个 hook）
 * ------------------------------------------------------------------ */

type Deps = readonly unknown[] | undefined;

interface StateHook {
  kind: 'state';
  value: unknown;
  set: (next: unknown) => void;
}

interface RefHook {
  kind: 'ref';
  ref: { current: unknown };
}

interface CallbackHook {
  kind: 'callback';
  deps: Deps;
  value: unknown;
}

interface EffectHook {
  kind: 'effect';
  /** 本次渲染写入的依赖 */
  deps: Deps;
  /** 上一次提交时的依赖；null 表示尚未提交过（等价于挂载） */
  committed: Deps | null;
  create: () => void | (() => void);
  cleanup: void | (() => void);
  mounted: boolean;
}

type HookSlot = StateHook | RefHook | CallbackHook | EffectHook;

/** React 19 的共享内部对象：`H` 就是当前 dispatcher 槽位 */
interface ReactInternals {
  H: unknown;
}

const INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

function reactInternals(): ReactInternals | null {
  const bag = React as unknown as Record<string, unknown>;
  const found = bag[INTERNALS_KEY];
  if (typeof found !== 'object' || found === null) return null;
  return found as ReactInternals;
}

function depsEqual(a: Deps, b: Deps): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/**
 * 极简 hook 运行时：把一个「函数组件式」的 hook 调用渲染成可反复重渲染的实例。
 */
class HookRuntime {
  private slots: HookSlot[] = [];
  private cursor = 0;
  private dirty = false;
  private rendering = false;

  private mode: GameMode = 'ai';
  private api: AiGameApi | null = null;

  constructor(private readonly render: (mode: GameMode) => AiGameApi) {}

  /** 首次挂载 */
  mount(mode: GameMode = 'ai'): AiGameApi {
    this.mode = mode;
    this.dirty = true;
    this.flush();
    return this.requireApi();
  }

  /** 卸载：按 React 顺序执行所有 cleanup */
  unmount(): void {
    for (const slot of this.slots) {
      if (slot.kind === 'effect' && slot.mounted) {
        slot.mounted = false;
        this.runCleanup(slot);
      }
    }
    this.slots = [];
  }

  /** 模拟父组件传入新的 props（mode） */
  setMode(mode: GameMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.dirty = true;
    this.flush();
  }

  get current(): AiGameApi {
    return this.requireApi();
  }

  private requireApi(): AiGameApi {
    if (this.api === null) throw new Error('hook 尚未渲染');
    return this.api;
  }

  private flush(): void {
    if (this.rendering) return;
    this.rendering = true;
    try {
      let guard = 0;
      while (this.dirty && guard < 64) {
        guard += 1;
        this.dirty = false;
        this.cursor = 0;
        this.api = this.renderWithDispatcher();
        this.commitEffects();
      }
    } finally {
      this.rendering = false;
    }
  }

  private renderWithDispatcher(): AiGameApi {
    const internals = reactInternals();
    const previous = internals?.H ?? null;
    if (internals) internals.H = this.dispatcher();
    try {
      return this.render(this.mode);
    } finally {
      if (internals) internals.H = previous;
    }
  }

  private dispatcher(): Record<string, unknown> {
    return {
      useState: (initial: unknown): [unknown, (next: unknown) => void] => {
        const slot = this.slotAt<StateHook>(this.cursor, () => ({
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => unknown)() : initial,
          set: (next: unknown): void => {
            const resolved =
              typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next;
            // React bailout：值没变就不重渲染
            if (Object.is(resolved, slot.value)) return;
            slot.value = resolved;
            this.dirty = true;
            this.flush();
          },
        }));
        this.cursor += 1;
        return [slot.value, slot.set];
      },
      useRef: (initial: unknown): { current: unknown } => {
        const slot = this.slotAt<RefHook>(this.cursor, () => ({ kind: 'ref', ref: { current: initial } }));
        this.cursor += 1;
        return slot.ref;
      },
      useCallback: (fn: unknown, deps: Deps): unknown => {
        const slot = this.slotAt<CallbackHook>(this.cursor, () => ({
          kind: 'callback',
          deps,
          value: fn,
        }));
        if (!depsEqual(slot.deps, deps)) {
          slot.deps = deps;
          slot.value = fn;
        }
        this.cursor += 1;
        return slot.value;
      },
      useEffect: (create: () => void | (() => void), deps: Deps): void => {
        const slot = this.slotAt<EffectHook>(this.cursor, () => ({
          kind: 'effect',
          deps,
          committed: null,
          create,
          cleanup: undefined,
          mounted: false,
        }));
        slot.create = create;
        slot.deps = deps;
        this.cursor += 1;
      },
    };
  }

  private slotAt<T extends HookSlot>(index: number, factory: () => T): T {
    const existing = this.slots[index];
    if (existing === undefined) {
      const created = factory();
      this.slots[index] = created;
      return created;
    }
    return existing as T;
  }

  /** 提交 effect：先跑所有变化的 cleanup，再跑所有变化的 create（与 React 同序） */
  private commitEffects(): void {
    const changed: EffectHook[] = [];
    for (const slot of this.slots) {
      if (slot.kind !== 'effect') continue;
      const shouldRun = slot.committed === null || !depsEqual(slot.deps, slot.committed);
      if (shouldRun) changed.push(slot);
    }
    for (const slot of changed) {
      if (slot.mounted) this.runCleanup(slot);
    }
    for (const slot of changed) {
      slot.mounted = true;
      slot.committed = slot.deps;
      const cleanup = slot.create();
      slot.cleanup = cleanup;
    }
  }

  private runCleanup(slot: EffectHook): void {
    const cleanup = slot.cleanup;
    slot.cleanup = undefined;
    if (typeof cleanup === 'function') cleanup();
  }
}

/* ------------------------------------------------------------------ *
 * 二、测试夹具
 * ------------------------------------------------------------------ */

interface FakeStorage {
  data: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function installStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map<string, string>(Object.entries(initial));
  const storage: FakeStorage = {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  return storage;
}

/** 让 localStorage 的**读取属性本身**就抛异常（隐私模式 / 存储被禁用） */
function installThrowingStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: localStorage is disabled');
    },
  });
}

const runtimes: HookRuntime[] = [];

function mountAi(settings: { color: PlayerColor; difficulty?: string }): HookRuntime {
  installStorage({
    'gomoku.ai.difficulty': settings.difficulty ?? 'easy',
    'gomoku.ai.playerColor': String(settings.color),
  });
  const runtime = new HookRuntime((mode) => useAiGame(mode));
  runtimes.push(runtime);
  runtime.mount('ai');
  return runtime;
}

/** 轮询等待异步收敛（AI 搜索是 setTimeout 分片驱动的） */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.unmount();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 三、useAiGame 编排行为
 * ------------------------------------------------------------------ */

describe('useAiGame 编排（真实 hook 驱动）', () => {
  it('切换引擎保留棋盘并取消旧对手搜索，以新引擎继续当前回合', () => {
    const cancelled = vi.fn();
    const search = vi.spyOn(aiSearch, 'runAiSearch').mockReturnValue(cancelled);
    const runtime = mountAi({ color: BLACK });
    expect(runtime.current.backend).toBe('rust-wasm');
    runtime.current.play(7, 7);
    const board = runtime.current.aiGame;
    expect(search.mock.calls[0]?.[2].backend).toBe('rust-wasm');

    runtime.current.setBackend('ts');

    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(runtime.current.aiGame).toBe(board);
    expect(runtime.current.thinking).toBe(true);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]?.[2].backend).toBe('ts');
    expect(globalThis.localStorage.getItem('gomoku.ai.backend')).toBe('ts');
  });

  it('切换引擎取消旧提示，下一次提示使用新引擎', () => {
    const cancelled = vi.fn();
    const search = vi.spyOn(aiSearch, 'runAiSearch').mockReturnValue(cancelled);
    const runtime = mountAi({ color: BLACK });
    runtime.current.requestHint();
    expect(search.mock.calls[0]?.[2].backend).toBe('rust-wasm');
    expect(runtime.current.hintThinking).toBe(true);

    runtime.current.setBackend('ts');

    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(runtime.current.hintThinking).toBe(false);
    expect(runtime.current.hint).toBeNull();
    runtime.current.requestHint();
    expect(search.mock.calls[1]?.[2].backend).toBe('ts');
  });

  it('重复选择当前引擎不打断正在进行的搜索', () => {
    const cancelled = vi.fn();
    const search = vi.spyOn(aiSearch, 'runAiSearch').mockReturnValue(cancelled);
    const runtime = mountAi({ color: BLACK });
    runtime.current.play(7, 7);
    runtime.current.setBackend('rust-wasm');
    expect(search).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    expect(runtime.current.thinking).toBe(true);
  });

  it('默认执黑：挂载后不思考，轮到玩家落子', () => {
    const runtime = mountAi({ color: BLACK });
    const api = runtime.current;

    expect(api.thinking).toBe(false);
    expect(api.aiGame.moves).toHaveLength(0);
    expect(isPlayerTurn(api.aiGame, BLACK)).toBe(true);
    expect(api.canUndo).toBe(false);
  });

  it('执白：AI 自动完成天元开局，玩家首手不被吞', async () => {
    const runtime = mountAi({ color: WHITE });
    expect(runtime.current.thinking).toBe(true);

    const settled = await waitUntil(() => runtime.current.aiGame.moves.length === 1);
    expect(settled, 'AI 执黑未能自动落子（thinking 未收敛）').toBe(true);

    const api = runtime.current;
    expect(api.thinking).toBe(false);
    expect(api.aiGame.moves[0]).toEqual({ x: 7, y: 7, c: BLACK });
    expect(isPlayerTurn(api.aiGame, WHITE)).toBe(true);

    // 玩家首手必须生效（不能被开局逻辑吞掉）
    api.play(0, 0);
    expect(runtime.current.aiGame.moves).toHaveLength(2);
    expect(runtime.current.aiGame.moves[1]).toEqual({ x: 0, y: 0, c: WHITE });
  });

  it('玩家落子后进入 thinking，思考期连点 10 次 moves 长度不变', async () => {
    const runtime = mountAi({ color: BLACK });
    runtime.current.play(7, 7);

    const api = runtime.current;
    expect(api.aiGame.moves).toHaveLength(1);
    expect(api.thinking).toBe(true);

    const snapshot = api.aiGame;
    for (let i = 0; i < 10; i += 1) api.play(i, 0);

    expect(runtime.current.aiGame.moves).toHaveLength(1);
    // 「0 变更」是对象级保证：thinking 期连点返回的是同一个 GameState
    expect(runtime.current.aiGame).toBe(snapshot);

    // 收敛：AI 落子后 thinking 关闭，且只多了一手
    const settled = await waitUntil(() => runtime.current.thinking === false);
    expect(settled, 'AI 思考未收敛').toBe(true);
    expect(runtime.current.aiGame.moves).toHaveLength(2);
    expect(runtime.current.aiLastMove).not.toBeNull();
  });

  it('切到联机：thinking 立即收敛，取消后不再落子（无残留定时器）', async () => {
    const runtime = mountAi({ color: BLACK });
    runtime.current.play(7, 7);
    expect(runtime.current.thinking).toBe(true);

    runtime.setMode('online');
    expect(runtime.current.thinking).toBe(false);
    const movesWhenLeft = runtime.current.aiGame.moves.length;

    await flushMicrotasks();
    expect(runtime.current.aiGame.moves).toHaveLength(movesWhenLeft);

    // 切回人机：AI 回合必须被重新调度（依赖 mode 变化）
    runtime.setMode('ai');
    expect(runtime.current.thinking).toBe(true);
  });

  it('localStorage 读取抛异常时仍能挂载并降级为「最强 + 执黑」', () => {
    installThrowingStorage();
    const runtime = new HookRuntime((mode) => useAiGame(mode));
    runtimes.push(runtime);

    const api = runtime.mount('ai');
    expect(api.playerColor).toBe(BLACK);
    expect(api.difficulty).toBe('hard');
    expect(api.thinking).toBe(false);
  });

  /**
   * 【源码 Bug · 高】重开（或重复点同一执子）会让 AI 回合永久丢失。
   *
   * 复现：执白 → AI 正在思考首手（moves.length === 0）→ 点「重新开始」。
   * `restart()` 只做 `stopSearch() + setGame(createAiGame())`；
   * 而 AI 回合 effect 的依赖是 `[game.moves.length, mode, playerColor, difficulty]`，
   * 空盘重开后这四个值**全都没变**（0 → 0），effect 不会重跑，
   * 于是既没有新搜索，也没有任何一手落下 → 棋盘永久停在「AI 回合」且不可点击。
   *
   * 这条断言写的是**正确行为**（重开后 AI 必须重新思考），当前实现会红。
   */
  it('玩家执白 + AI 思考中重开：AI 回合重新调度并完成落子', async () => {
    const runtime = mountAi({ color: WHITE });
    expect(runtime.current.thinking).toBe(true);

    runtime.current.restart();

    expect(runtime.current.aiGame.moves).toHaveLength(0);
    expect(
      runtime.current.thinking,
      '重开后 thinking 仍应为 true（AI 需要重新走首手），实际为 false → AI 回合永久丢失',
    ).toBe(true);

    // 玩家误点不得取消重开的新搜索，随后 AI 必须完成首手。
    runtime.current.play(7, 7);
    expect(runtime.current.aiGame.moves).toHaveLength(0);
    expect(runtime.current.thinking).toBe(true);
    expect(await waitUntil(() => !runtime.current.thinking)).toBe(true);
    expect(runtime.current.aiGame.moves).toHaveLength(1);
  });

  /** 【源码 Bug · 高】同一个根因的第二条可达路径：思考中重复点「执白（后手）」。 */
  it('[源码 Bug] 玩家执白 + AI 思考中重复选同一执子：AI 回合必须重新调度', () => {
    const runtime = mountAi({ color: WHITE });
    expect(runtime.current.thinking).toBe(true);

    runtime.current.setPlayerColor(WHITE);

    expect(runtime.current.aiGame.moves).toHaveLength(0);
    expect(
      runtime.current.thinking,
      '换边（同色重开）后 AI 应重新思考首手，实际为 false → AI 回合永久丢失',
    ).toBe(true);
  });

  /**
   * 【源码 Bug · 同根因】思考期程序化调用 `undo()`。
   *
   * `canUndo` 在 thinking 期为 false，所以按钮是禁用的（无 UI 路径），
   * 但 `undo()` 本身没有守卫：它会先 `stopSearch()` 取消搜索，再因为
   * `canUndoPair` 返回 false 而不改棋局 —— 结果「搜索被取消 + 棋局没变 + 依赖没变」，
   * 与重开完全同构，AI 回合同样永久丢失。
   * 这条用例说明根因是「stopSearch 之后没有任何东西重新触发 AI 回合」，
   * 而不是某一个按钮忘了禁用。
   */
  it('[源码 Bug · 同根因] 思考期 undo() 不应取消搜索（当前会丢失 AI 回合）', () => {
    const runtime = mountAi({ color: BLACK });
    runtime.current.play(7, 7);
    expect(runtime.current.thinking).toBe(true);

    runtime.current.undo();

    // 悔棋本身被正确拒绝（思考期不允许悔棋）
    expect(runtime.current.aiGame.moves).toHaveLength(1);
    // 但搜索不该被顺手取消掉：AI 仍应处于思考中
    expect(runtime.current.thinking, 'undo() 取消了搜索却没有重新调度 AI').toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 四、aiGame 纯函数边界（AI 返回非法点 / 终局 / 悔棋语义）
 * ------------------------------------------------------------------ */

describe('aiGame 边界与终局', () => {
  it('AI 返回已被占的点：拒绝且棋局对象不变', () => {
    let g = createAiGame();
    g = playPlayerMove(g, 7, 7, BLACK).game;

    const outcome = playAiMove(g, 7, 7, WHITE);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('occupied');
    expect(outcome.game).toBe(g);
  });

  it('AI 返回越界点：拒绝且棋局不变', () => {
    const g = playPlayerMove(createAiGame(), 7, 7, BLACK).game;
    const outcome = playAiMove(g, 15, 0, WHITE);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('out-of-board');
    expect(outcome.game).toBe(g);
  });

  it('AI 落子恰好成五：over=true + winLine 非空，悔棋被禁用', () => {
    let g = createAiGame();
    // 黑（AI）已有 4 连，白（玩家）在别处落子
    for (let i = 0; i < 4; i += 1) {
      g = playAiMove(g, 3 + i, 5, BLACK).game;
      g = playPlayerMove(g, 3 + i, 9, WHITE).game;
    }
    expect(g.over).toBe(false);

    const outcome = playAiMove(g, 7, 5, BLACK);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.event).toBe('win');
    expect(outcome.game.over).toBe(true);
    expect(outcome.game.winLine).not.toBeNull();
    // 终局禁止悔棋（与联机路径一致）
    expect(canUndoPair(outcome.game, WHITE, false)).toBe(false);
    // 终局后玩家落子被拒
    expect(playPlayerMove(outcome.game, 0, 14, WHITE).ok).toBe(false);
  });

  it('平局终局：悔棋被禁用、玩家落子被拒、AI 不再被调度', () => {
    const draw: GameState = {
      ...createAiGame(),
      over: true,
      moves: [{ x: 0, y: 0, c: BLACK }],
      winLine: null,
    };

    expect(canUndoPair(draw, BLACK, false)).toBe(false);
    expect(playPlayerMove(draw, 1, 1, BLACK).ok).toBe(false);
    expect(isPlayerTurn(draw, BLACK)).toBe(false);
  });

  it('moves.length < 2 时不可悔棋（我方还没落过子）', () => {
    const g = createAiGame();
    expect(canUndoPair(g, BLACK, false)).toBe(false);
    expect(canUndoPair(g, WHITE, false)).toBe(false);
    expect(undoPair(g, BLACK)).toBe(g);
  });

  it('悔棋两步后 currentColor === 玩家颜色，且我方棋数减 1', () => {
    let g = createAiGame();
    g = playPlayerMove(g, 7, 7, BLACK).game;
    g = playAiMove(g, 8, 8, WHITE).game;
    g = playPlayerMove(g, 6, 6, BLACK).game;
    g = playAiMove(g, 9, 9, WHITE).game;

    expect(canUndoPair(g, BLACK, false)).toBe(true);
    const after = undoPair(g, BLACK);

    expect(after.moves).toHaveLength(2);
    expect(currentColor(after)).toBe(BLACK);
    expect(stoneCount(after, BLACK)).toBe(1);
    expect(isPlayerTurn(after, BLACK)).toBe(true);
  });

  it('退两步永远回到玩家回合，AI 不会立刻重下（架构 §10.1 只在「退一步」时成立）', () => {
    // 玩家执黑：[B, W, B, W] → 退两步 → [B, W]，仍轮到黑（玩家）
    let black = createAiGame();
    black = playPlayerMove(black, 7, 7, BLACK).game;
    black = playAiMove(black, 8, 8, WHITE).game;
    black = playPlayerMove(black, 6, 6, BLACK).game;
    black = playAiMove(black, 9, 9, WHITE).game;

    const afterBlack = undoPair(black, BLACK);
    expect(afterBlack.moves).toHaveLength(2);
    expect(currentColor(afterBlack)).toBe(BLACK);
    expect(isPlayerTurn(afterBlack, BLACK)).toBe(true);

    // 玩家执白：[B, W, B] → 退两步 → [B]，仍轮到白（玩家）
    let white = createAiGame();
    white = playAiMove(white, 7, 7, BLACK).game;
    white = playPlayerMove(white, 0, 0, WHITE).game;
    white = playAiMove(white, 8, 8, BLACK).game;

    expect(canUndoPair(white, WHITE, false)).toBe(true);
    const afterWhite = undoPair(white, WHITE);
    expect(afterWhite.moves).toHaveLength(1);
    expect(currentColor(afterWhite)).toBe(WHITE);
    expect(isPlayerTurn(afterWhite, WHITE)).toBe(true);
    // 「不会卡死」：玩家可以立刻继续落子
    expect(playPlayerMove(afterWhite, 1, 1, WHITE).ok).toBe(true);
  });

  it('lastMoveOf 取的是该方最后一手（AI 高亮用）', () => {
    let g = createAiGame();
    g = playPlayerMove(g, 7, 7, BLACK).game;
    g = playAiMove(g, 8, 8, WHITE).game;
    g = playPlayerMove(g, 6, 6, BLACK).game;

    expect(lastMoveOf(g, WHITE)).toEqual({ x: 8, y: 8, c: WHITE });
    expect(lastMoveOf(g, BLACK)).toEqual({ x: 6, y: 6, c: BLACK });
    expect(lastMoveOf(createAiGame(), BLACK)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 五、Bug 可达性：Board 的「重新开始」在 thinking 期间仍可点击
 * ------------------------------------------------------------------ */

describe('Board 的重新开始按钮未受 thinking 保护（Bug 可达性）', () => {
  it('restart 按钮的 disabled 只依赖 connected，不依赖 thinking / canUndo', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(process.cwd(), 'packages/web/src/components/Board/Board.tsx'),
      'utf8',
    );

    const restart = source.slice(source.indexOf('id="restart-btn"'));
    const disabled = restart.slice(restart.indexOf('disabled='), restart.indexOf('onClick='));

    expect(disabled).toContain('!connected');
    // 人机模式下 connected 恒为 true ⇒ 思考期该按钮可点 ⇒ 触发上面的死锁
    expect(disabled, 'restart 按钮应同时受 thinking 保护').toMatch(/thinking/);
  });
});
