import { describe, expect, it } from 'vitest';
import { gamePage } from '../../src/lobby/navigation';

describe('对弈入口导航', () => {
  it('没有房间时联机入口回到大厅选择开局方式', () => {
    expect(gamePage('online', false)).toBe('lobby');
  });

  it('已有房间时联机入口回到原房间', () => {
    expect(gamePage('online', true)).toBe('game');
  });

  it.each([false, true])('人机对弈不依赖是否已有房间（%s）', hasRoom => {
    expect(gamePage('ai', hasRoom)).toBe('game');
  });
});
