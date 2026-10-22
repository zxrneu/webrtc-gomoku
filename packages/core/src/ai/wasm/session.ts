import type { AiOptions, AiSession, GameState, PlayerColor } from '../types';
import { createSearchSession } from '../search';
import { createKernel } from './kernel';

/** 保留完整对弈算法，为每个会话单独实例化 Rust/WASM 评分内存。 */
export function createWasmSearchSession(game: GameState, color: PlayerColor, options: AiOptions = {}): AiSession {
  const kernel = options.backend === 'ts' ? null : createKernel();
  const scoring = kernel?.isWasm ? kernel : undefined;
  const session = createSearchSession(game, color, { ...options, scoring });
  return {
    difficulty: session.difficulty,
    step: (budget) => session.step(budget),
    result: () => session.result(),
    abort: () => session.abort(),
    stats: () => ({ ...session.stats(), backend: scoring ? 'rust-wasm' : 'ts' }),
  };
}
