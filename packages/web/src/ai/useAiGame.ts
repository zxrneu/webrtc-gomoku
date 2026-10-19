/**
 * 人机对战的 React 编排层。
 *
 * 本文件返回的对象是**人机模式 UI 的唯一契约**（tasks.md §2）：
 * `App` / `AiPanel` / `Board` 只读它，不允许各自再持有 `moves` / `thinking` 之类的镜像状态。
 *
 * 时序（架构 §5 / §3.1）：
 * ```
 * play(x,y) → 纯函数守卫 → setGame → 渲染 → effect 发现轮到 AI
 *   → setThinking(true) → 渲染「AI 正在思考…」 → schedule 让出
 *   → 分片搜索 → onDone → setGame(落子) + setThinking(false)
 * ```
 * `setThinking(true)` 与搜索之间隔着一次 `schedule`，所以 thinking 必定先上屏。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Difficulty, GameState, Move, PlayerColor } from '@webrtc-gomoku/core';
import { BLACK, currentColor } from '@webrtc-gomoku/core';

import { sounds } from '../audio';
import type { GameMode } from '../types';
import {
  aiColorOf,
  canUndoPair,
  createAiGame,
  lastMoveOf,
  playAiMove,
  playPlayerMove,
  undoPair,
} from './aiGame';
import type { AiSettings } from './aiStorage';
import { loadAiSettings, saveDifficulty, savePlayerColor } from './aiStorage';
import { runAiSearch } from './aiSearch';
import { useAiHint } from './useAiHint';

/** 人机模式的对外 API（UI 只允许依赖这个接口） */
export interface AiGameApi extends ReturnType<typeof useAiHint> {
  /** 当前人机棋局（胜负判定唯一来源是 core） */
  readonly aiGame: GameState;
  /** 玩家执子颜色 */
  readonly playerColor: PlayerColor;
  /** 当前局生效的难度 */
  readonly difficulty: Difficulty;
  /** 已选择但尚未生效的难度（下一局生效，PRD US-2） */
  readonly pendingDifficulty: Difficulty;
  /** AI 是否正在思考（思考期禁落子） */
  readonly thinking: boolean;
  /** AI 最后一手（用于棋盘区分标记与面板信息） */
  readonly aiLastMove: Move | null;
  /** 当前是否可悔棋（一次退两步） */
  readonly canUndo: boolean;
  /** 玩家落子；思考中 / 终局 / 非玩家回合会被纯函数守卫拒绝 */
  readonly play: (x: number, y: number) => void;
  /** 悔棋：退两步回到玩家回合 */
  readonly undo: () => void;
  /** 重开：清盘但保留先后手与难度（难度取 pending） */
  readonly restart: () => void;
  /** 切换执子：换边必然重开（否则棋谱颜色与执子不一致） */
  readonly setPlayerColor: (color: PlayerColor) => void;
  /** 选择难度：写 pending，下一局生效（不打断当前局） */
  readonly setDifficulty: (difficulty: Difficulty) => void;
}

/**
 * 人机对战编排 hook。
 *
 * @param mode 当前视图模式；只有 `'ai'` 时才会驱动 AI 回合
 * @returns 人机模式的完整 UI 契约
 */
export function useAiGame(mode: GameMode): AiGameApi {
  // 初始值来自 localStorage（异常自动降级为「最强 + 执黑」），只读一次
  const [settings, setSettings] = useState<AiSettings>(loadAiSettings);
  const [pendingDifficulty, setPendingDifficulty] = useState<Difficulty>(settings.difficulty);
  const [game, setGame] = useState<GameState>(createAiGame);
  const [thinking, setThinking] = useState(false);
  const [gameRevision, setGameRevision] = useState(0);

  const hint = useAiHint(game, settings.playerColor, mode === 'ai');

  /** 当前搜索的取消函数（卸载 / 切模式 / 悔棋 / 重开必须调用） */
  const cancelRef = useRef<(() => void) | null>(null);

  /** 中止进行中的搜索并复位 thinking */
  const stopSearch = useCallback(() => {
    const cancel = cancelRef.current;
    cancelRef.current = null;
    if (cancel) cancel();
    setThinking(false);
  }, []);

  // 组件卸载时兜底取消，避免「已卸载组件里 onDone 改状态」
  useEffect(() => stopSearch, [stopSearch]);

  /* ---------------- AI 回合触发（架构 §6） ---------------- */
  useEffect(() => {
    if (mode !== 'ai') {
      setThinking(false);
      return undefined;
    }
    // 终局或轮到玩家：不启动搜索
    if (game.over || currentColor(game) === settings.playerColor) {
      setThinking(false);
      return undefined;
    }
    const aiColor = aiColorOf(settings.playerColor);
    // 先上屏：setThinking 之后才 schedule，保证「AI 正在思考…」先于搜索可见
    setThinking(true);
    const cancel = runAiSearch(
      game,
      aiColor,
      { difficulty: settings.difficulty },
      {},
      (move) => {
        cancelRef.current = null;
        setThinking(false);
        if (move === null) return;
        setGame((prev) => {
          const outcome = playAiMove(prev, move[0], move[1], aiColor);
          if (!outcome.ok) return prev;
          sounds.playStone(aiColor === BLACK);
          if (outcome.event === 'win') sounds.playWin();
          return outcome.game;
        });
      },
    );
    cancelRef.current = cancel;
    return () => {
      cancelRef.current = null;
      cancel();
    };
    // 新局编号保证同手数、同设置的重开也会重新评估 AI 回合
  }, [game.moves.length, mode, settings.playerColor, settings.difficulty, gameRevision]);

  /* ---------------- 玩家操作 ---------------- */

  const play = useCallback(
    (x: number, y: number) => {
      setGame((prev) => {
        const outcome = playPlayerMove(prev, x, y, settings.playerColor, thinking);
        if (!outcome.ok) return prev;
        sounds.playStone(settings.playerColor === BLACK);
        if (outcome.event === 'win') sounds.playWin();
        return outcome.game;
      });
    },
    [settings.playerColor, thinking],
  );

  const undo = useCallback(() => {
    if (thinking || !canUndoPair(game, settings.playerColor)) return;
    stopSearch();
    setGame((prev) => undoPair(prev, settings.playerColor));
  }, [game, thinking, settings.playerColor, stopSearch]);

  const restart = useCallback(() => {
    stopSearch();
    // 重开是「下一局生效」的唯一时机：把 pending 难度提交为当前难度
    setSettings((prev) => ({ ...prev, difficulty: pendingDifficulty }));
    setGame(createAiGame());
    setGameRevision((revision) => revision + 1);
  }, [pendingDifficulty, stopSearch]);

  const setPlayerColor = useCallback(
    (color: PlayerColor) => {
      stopSearch();
      savePlayerColor(color);
      setSettings((prev) => ({ ...prev, playerColor: color }));
      // 换边必然重开：否则「黑子数量 = 我执黑」的隐含前提被破坏
      setGame(createAiGame());
      setGameRevision((revision) => revision + 1);
    },
    [stopSearch],
  );

  const setDifficulty = useCallback((difficulty: Difficulty) => {
    saveDifficulty(difficulty);
    // 不打断当前局：只写 pending，`restart()` 时生效（架构 §10.3）
    setPendingDifficulty(difficulty);
  }, []);

  return {
    ...hint,
    aiGame: game,
    playerColor: settings.playerColor,
    difficulty: settings.difficulty,
    pendingDifficulty,
    thinking,
    aiLastMove: lastMoveOf(game, aiColorOf(settings.playerColor)),
    canUndo: canUndoPair(game, settings.playerColor, thinking),
    play,
    undo,
    restart,
    setPlayerColor,
    setDifficulty,
  };
}
