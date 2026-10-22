/** 按当前棋局请求建议；棋局或模式变化时取消，旧回调不得更新新局面。 */
import { useCallback, useEffect, useState } from 'react';
import { HINT_SEARCH_OPTIONS, currentColor, type GameState, type PlayerColor } from '@webrtc-gomoku/core';
import { runAiSearch } from './aiSearch';
import { explainHint, type AiHint } from './aiHint';
import type { AiBackend } from './backendOptions';

interface HintRequest {
  readonly game: GameState;
  readonly backend?: AiBackend;
}

interface HintResult extends HintRequest {
  readonly hint: AiHint | null;
}

interface HintOptions {
  readonly enabled: boolean;
  readonly backend?: AiBackend;
}

export function useAiHint(game: GameState, color: PlayerColor, { enabled, backend }: HintOptions) {
  const [requested, setRequested] = useState<HintRequest | null>(null);
  const [result, setResult] = useState<HintResult | null>(null);
  const canHint = enabled && !game.over && currentColor(game) === color;

  useEffect(() => {
    setRequested(null);
    setResult(null);
  }, [game, color, enabled, backend]);

  useEffect(() => {
    if (!canHint || requested?.game !== game || requested.backend !== backend) return;
    let cancelled = false;
    const cancel = runAiSearch(game, color, { ...HINT_SEARCH_OPTIONS, backend }, {}, (point) => {
      if (cancelled) return;
      setResult({ game, backend, hint: point === null ? null : explainHint(game, point, color) });
    });
    return () => { cancelled = true; cancel(); };
  }, [game, color, canHint, requested, backend]);

  const requestHint = useCallback(() => {
    if (!canHint) return;
    setResult(null);
    setRequested({ game, backend });
  }, [game, canHint, backend]);
  const currentResult = canHint && result?.game === game && result.backend === backend ? result : null;
  return {
    hint: currentResult?.hint ?? null,
    hintThinking: canHint && requested?.game === game && requested.backend === backend && currentResult === null,
    hintUnavailable: currentResult !== null && currentResult.hint === null,
    canHint,
    requestHint,
  };
}
