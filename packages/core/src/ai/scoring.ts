import type { AiBoard } from './types';

/** 会话独享的评分后端；搜索只依赖这个契约，不依赖 WASM 实现。 */
export interface PositionScoring {
  readonly isWasm: boolean;
  setBoard(cells: AiBoard): void;
  setCell(at: number, color: number): void;
  windowScore(at: number, direction: number, color: number): number;
  pointScore(at: number, color: number): number;
}
