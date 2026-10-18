import { describe, expect, it } from 'vitest';

import {
  FAIL_REASONS,
  RETRY_RULES,
  classifyFailure,
  isRoomInvalidError,
  isUnsupportedMessageError,
  type FailReason,
} from '../../src/reconnect/classify';

describe('classify · FailReason 枚举', () => {
  it('FAIL_REASONS 恰好是 K2 规定的 9 个字面量', () => {
    expect(FAIL_REASONS).toEqual([
      'NETWORK_OFFLINE',
      'WS_CLOSED',
      'WS_TIMEOUT',
      'SERVER_REJECTED',
      'SERVER_RESTART',
      'ICE_FAILED',
      'DC_NOT_OPEN',
      'POLICY_EXHAUSTED',
      'USER_CANCELLED',
    ]);
  });
});

describe('classify · 每类 FailReason 的「是否计 attempt / 是否可重试」映射', () => {
  const expected: Record<FailReason, { countsAttempt: boolean; autoRetry: boolean }> = {
    NETWORK_OFFLINE: { countsAttempt: true, autoRetry: true },
    WS_CLOSED: { countsAttempt: true, autoRetry: true },
    WS_TIMEOUT: { countsAttempt: true, autoRetry: true },
    SERVER_REJECTED: { countsAttempt: false, autoRetry: false },
    SERVER_RESTART: { countsAttempt: true, autoRetry: true },
    ICE_FAILED: { countsAttempt: false, autoRetry: true },
    DC_NOT_OPEN: { countsAttempt: false, autoRetry: false },
    POLICY_EXHAUSTED: { countsAttempt: false, autoRetry: false },
    USER_CANCELLED: { countsAttempt: false, autoRetry: false },
  };

  it('RETRY_RULES 的 countsAttempt / autoRetry 与设计 §8.1 逐项一致', () => {
    for (const reason of FAIL_REASONS) {
      expect(
        { countsAttempt: RETRY_RULES[reason].countsAttempt, autoRetry: RETRY_RULES[reason].autoRetry },
        reason
      ).toEqual(expected[reason]);
    }
  });

  it('除 USER_CANCELLED 外每个 FailReason 都有非空的中文文案', () => {
    for (const reason of FAIL_REASONS) {
      if (reason === 'USER_CANCELLED') {
        expect(RETRY_RULES[reason].label).toBe('');
      } else {
        expect(RETRY_RULES[reason].label.length).toBeGreaterThan(0);
      }
    }
  });

  it('POLICY_EXHAUSTED 的文案为「多次重试失败」（PRD §6.4 逐字）', () => {
    expect(RETRY_RULES.POLICY_EXHAUSTED.label).toBe('多次重试失败');
  });

  it('SERVER_RESTART 的文案为「服务器已重启，房间失效」（PRD §6.4 逐字）', () => {
    expect(RETRY_RULES.SERVER_RESTART.label).toBe('服务器已重启，房间失效');
  });
});

describe('classify · classifyFailure', () => {
  it('离线时 socket 关闭归类 NETWORK_OFFLINE', () => {
    expect(classifyFailure({ source: 'ws-close', online: false, closeCode: 1006 })).toBe('NETWORK_OFFLINE');
  });

  it('在线时 socket 异常关闭（1006）归类 WS_CLOSED', () => {
    expect(classifyFailure({ source: 'ws-close', online: true, closeCode: 1006 })).toBe('WS_CLOSED');
  });

  it('socket error 归类 WS_CLOSED', () => {
    expect(classifyFailure({ source: 'ws-error', online: true })).toBe('WS_CLOSED');
  });

  it('WS 心跳判死归类 WS_TIMEOUT', () => {
    expect(classifyFailure({ source: 'ws-heartbeat' })).toBe('WS_TIMEOUT');
  });

  it('连接超时且在线时归类 WS_TIMEOUT', () => {
    expect(classifyFailure({ source: 'connect-timeout', online: true })).toBe('WS_TIMEOUT');
  });

  it('连接超时且离线时归类 NETWORK_OFFLINE', () => {
    expect(classifyFailure({ source: 'connect-timeout', online: false })).toBe('NETWORK_OFFLINE');
  });

  it('PC 状态失败归类 ICE_FAILED', () => {
    expect(classifyFailure({ source: 'pc-state' })).toBe('ICE_FAILED');
  });

  it('DC 心跳失败归类 ICE_FAILED', () => {
    expect(classifyFailure({ source: 'dc-heartbeat' })).toBe('ICE_FAILED');
  });

  it('DC 发送失败归类 DC_NOT_OPEN', () => {
    expect(classifyFailure({ source: 'dc-send' })).toBe('DC_NOT_OPEN');
  });

  it('ICE restart 失败归类 ICE_FAILED', () => {
    expect(classifyFailure({ source: 'ice-restart' })).toBe('ICE_FAILED');
  });

  it('resume 被拒归类 SERVER_RESTART（房间已失效）', () => {
    expect(
      classifyFailure({ source: 'resume-rejected', serverCode: 'RESUME_REJECTED', serverMessage: '房间已失效，请重新加入' })
    ).toBe('SERVER_RESTART');
  });

  it('房间已满文案归类 SERVER_REJECTED 且不计 attempt、不可自动重试', () => {
    const reason = classifyFailure({ source: 'server-error', serverMessage: '房间已满（仅支持 1v1）' });

    expect(reason).toBe('SERVER_REJECTED');
    expect(RETRY_RULES[reason].countsAttempt).toBe(false);
    expect(RETRY_RULES[reason].autoRetry).toBe(false);
  });

  it('房号格式非法文案归类 SERVER_REJECTED', () => {
    expect(classifyFailure({ source: 'server-error', serverMessage: '房间号需为 4 位字母或数字' })).toBe(
      'SERVER_REJECTED'
    );
  });

  it('未知错误码兜底为 SERVER_REJECTED（防无限重试）', () => {
    const reason = classifyFailure({ source: 'server-error', serverCode: 'SOMETHING_NEW', serverMessage: '未知' });

    expect(reason).toBe('SERVER_REJECTED');
    expect(RETRY_RULES[reason].autoRetry).toBe(false);
  });

  it('重试次数耗尽归类 POLICY_EXHAUSTED', () => {
    expect(classifyFailure({ source: 'attempts-exhausted', attempts: 6, maxAttempts: 6 })).toBe('POLICY_EXHAUSTED');
  });

  it('用户主动离开归类 USER_CANCELLED', () => {
    expect(classifyFailure({ source: 'user-leave' })).toBe('USER_CANCELLED');
  });
});

describe('classify · 文案识别辅助', () => {
  it('isUnsupportedMessageError 逐字命中旧服务端的「未知消息类型」', () => {
    expect(isUnsupportedMessageError('未知消息类型')).toBe(true);
    expect(isUnsupportedMessageError(' 未知消息类型 ')).toBe(true);
  });

  it('isUnsupportedMessageError 不误判其他错误文案', () => {
    expect(isUnsupportedMessageError('房间已满（仅支持 1v1）')).toBe(false);
    expect(isUnsupportedMessageError('')).toBe(false);
  });

  it('isRoomInvalidError 覆盖房号非法 / 已存在 / 不存在 / 已满', () => {
    expect(isRoomInvalidError('房间号需为 4 位字母或数字')).toBe(true);
    expect(isRoomInvalidError('房间 A8B2 已存在，请更换')).toBe(true);
    expect(isRoomInvalidError('房间 A8B2 不存在')).toBe(true);
    expect(isRoomInvalidError('房间已满（仅支持 1v1）')).toBe(true);
    expect(isRoomInvalidError('你已在房间 A8B2 中')).toBe(true);
  });

  it('isRoomInvalidError 不把未知文案当作房间无效', () => {
    expect(isRoomInvalidError('未知消息类型')).toBe(false);
    expect(isRoomInvalidError('服务器内部错误')).toBe(false);
  });
});
