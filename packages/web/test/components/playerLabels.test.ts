import { describe, expect, it } from 'vitest';
import { BLACK, WHITE } from '@webrtc-gomoku/core';
import { playerLabels } from '../../src/components/Match/playerLabels';

describe('棋盒玩家身份', () => {
  it.each([
    [BLACK, true, '松间 (我)', '听雨', '房主 (先行)', '加入方'],
    [WHITE, true, '听雨', '松间 (我)', '加入方 (先行)', '房主'],
    [BLACK, false, '松间 (我)', '听雨', '加入方 (先行)', '房主'],
    [WHITE, false, '听雨', '松间 (我)', '房主 (先行)', '加入方'],
  ] as const)('换边后身份跟随玩家（执子 %s，房主 %s）', (myColor, isHost, blackName, whiteName, blackTag, whiteTag) => {
    expect(playerLabels({ mode: 'online', myColor, isHost, myName: '松间', peerName: '听雨', difficulty: 'hard' }))
      .toEqual({ blackName, whiteName, blackTag, whiteTag });
  });

  it.each([BLACK, WHITE])('人机棋盒使用实际生效难度（执子 %s）', myColor => {
    const result = playerLabels({ mode: 'ai', myColor, isHost: false, myName: '', peerName: '', difficulty: 'easy' });
    expect(result[myColor === BLACK ? 'whiteName' : 'blackName']).toBe('AI（简单）');
    expect(result[myColor === BLACK ? 'blackName' : 'whiteName']).toBe('我');
  });
});
