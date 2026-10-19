/** 按当前棋局请求建议；棋局或模式变化时取消，旧回调不得更新新局面。 */
import { useCallback, useEffect, useState } from 'react';
import { HINT_SEARCH_OPTIONS, currentColor, type GameState, type PlayerColor } from '@webrtc-gomoku/core';
import { runAiSearch } from './aiSearch';
import { explainHint, type AiHint } from './aiHint';

interface HintResult {
  readonly game: GameState;
  readonly hint: AiHint | null;
}

export function useAiHint(game: GameState, color: PlayerColor, enabled: boolean) {
  const [requested, setRequested] = useState<{ game: GameState } | null>(null);
  const [result, setResult] = useState<HintResult | null>(null);
  const canHint = enabled && !game.over && currentColor(game) === color;

  useEffect(() => {
    setRequested(null);
    setResult(null);
  }, [game, color, enabled]);

  useEffect(() => {
    if (!canHint || requested?.game !== game) return;
    let cancelled = false;
    const cancel = runAiSearch(game, color, HINT_SEARCH_OPTIONS, {}, (point) => {
      if (cancelled) return;
      setResult({ game, hint: point === null ? null : explainHint(game, point, color) });
    });
    return () => { cancelled = true; cancel(); };
  }, [game, color, canHint, requested]);

  const requestHint = useCallback(() => {
    if (!canHint) return;
    setResult(null);
    setRequested({ game });
  }, [game, canHint]);
  const currentResult = canHint && result?.game === game ? result : null;
  return {
    hint: currentResult?.hint ?? null,
    hintThinking: canHint && requested?.game === game && currentResult === null,
    hintUnavailable: currentResult !== null && currentResult.hint === null,
    canHint,
    requestHint,
  };
}
