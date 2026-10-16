import { describe, expect, it } from 'vitest';
import type { ServerSignalingMsg } from '@webrtc-gomoku/shared';
import { RoomRegistry, type RoomClient } from '../src/rooms';

interface FakeClient extends RoomClient {
  sent: ServerSignalingMsg[];
}

function fakeClient(id: string): FakeClient {
  const sent: ServerSignalingMsg[] = [];
  return {
    id,
    sent,
    send(msg) {
      sent.push(msg);
    },
  };
}

function peerLeftCount(client: FakeClient): number {
  return client.sent.filter((m) => m.t === 'peer-left').length;
}

describe('RoomRegistry 建房', () => {
  it('创建成功后房间存在且自己已在房间内', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');

    const res = reg.create('AAAA', a);

    expect(res).toEqual({ ok: true, code: 'AAAA', left: null });
    expect(reg.roomCount).toBe(1);
    expect(reg.roomOf('a')).toBe('AAAA');
  });

  it('房号非 4 位字母数字时被拒绝，且不离开当前房间', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    reg.create('AAAA', a);

    const res = reg.create('ab', a);

    expect(res.ok).toBe(false);
    expect(reg.roomOf('a')).toBe('AAAA');
    expect(reg.roomCount).toBe(1);
  });

  it('房号已存在时被拒绝，且不离开当前房间', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    reg.create('AAAA', a);
    reg.create('BBBB', b);

    const res = reg.create('AAAA', b);

    expect(res).toEqual({ ok: false, message: '房间 AAAA 已存在，请更换' });
    expect(reg.roomOf('b')).toBe('BBBB');
  });

  it('从旧房间建房成功后，旧房间对端收到 peer-left', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    reg.create('AAAA', a);
    reg.join('AAAA', b);

    const res = reg.create('CCCC', b);

    expect(res).toEqual({ ok: true, code: 'CCCC', left: { code: 'AAAA', remaining: 1, destroyed: false } });
    expect(peerLeftCount(a)).toBe(1);
    expect(reg.roomOf('b')).toBe('CCCC');
  });
});

describe('RoomRegistry 加入房间', () => {
  it('加入不存在的房间被拒绝，且不离开当前房间', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    reg.create('AAAA', a);
    reg.join('AAAA', b);

    const res = reg.join('ZZZZ', b);

    expect(res).toEqual({ ok: false, message: '房间 ZZZZ 不存在' });
    expect(reg.roomOf('b')).toBe('AAAA');
    expect(reg.others('AAAA', 'b')).toHaveLength(1);
  });

  it('输错房号时原房间对端收不到 peer-left', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    reg.create('AAAA', a);
    reg.join('AAAA', b);

    reg.join('ZZZZ', b);

    expect(peerLeftCount(a)).toBe(0);
  });

  it('加入已满的房间被拒绝，且不离开当前房间', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    const c = fakeClient('c');
    reg.create('AAAA', a);
    reg.join('AAAA', b);
    reg.create('BBBB', c);

    const res = reg.join('AAAA', c);

    expect(res).toEqual({ ok: false, message: '房间已满（仅支持 1v1）' });
    expect(reg.roomOf('c')).toBe('BBBB');
    expect(peerLeftCount(a)).toBe(0);
  });

  it('换房成功后旧房间对端收到 peer-left，新房可查到两名成员', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    const c = fakeClient('c');
    reg.create('AAAA', a);
    reg.join('AAAA', b);
    reg.create('BBBB', c);

    const res = reg.join('BBBB', b);

    expect(res).toEqual({ ok: true, code: 'BBBB', left: { code: 'AAAA', remaining: 1, destroyed: false } });
    expect(peerLeftCount(a)).toBe(1);
    expect(reg.roomOf('b')).toBe('BBBB');
    expect(reg.others('BBBB', 'b').map((p) => p.id)).toEqual(['c']);
  });

  it('重复加入自己所在的房间被拒绝，对端无感知', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    reg.create('AAAA', a);
    reg.join('AAAA', b);

    const res = reg.join('AAAA', b);

    expect(res.ok).toBe(false);
    expect(reg.roomOf('b')).toBe('AAAA');
    expect(peerLeftCount(a)).toBe(0);
    expect(reg.roomCount).toBe(1);
  });

  it('独自在房间时重复加入不销毁房间', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    reg.create('AAAA', a);

    reg.join('AAAA', a);

    expect(reg.roomOf('a')).toBe('AAAA');
    expect(reg.roomCount).toBe(1);
  });
});

describe('RoomRegistry 离开房间', () => {
  it('还有队友时离开只通知对端，不销毁房间', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    reg.create('AAAA', a);
    reg.join('AAAA', b);

    const res = reg.leave('a');

    expect(res).toEqual({ code: 'AAAA', remaining: 1, destroyed: false });
    expect(peerLeftCount(b)).toBe(1);
    expect(reg.roomOf('a')).toBeNull();
    expect(reg.roomOf('b')).toBe('AAAA');
  });

  it('最后一人离开时销毁房间', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    reg.create('AAAA', a);

    const res = reg.leave('a');

    expect(res).toEqual({ code: 'AAAA', remaining: 0, destroyed: true });
    expect(reg.roomCount).toBe(0);
    expect(reg.roomOf('a')).toBeNull();
  });

  it('不在任何房间时离开是空操作', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');

    expect(reg.leave('a')).toEqual({ code: null, remaining: 0, destroyed: false });
    expect(reg.roomCount).toBe(0);
  });

  it('离开别人已建的房间不影响该房间', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    reg.create('AAAA', a);
    reg.join('AAAA', b);

    reg.leave('b');

    expect(reg.roomOf('a')).toBe('AAAA');
    expect(reg.roomCount).toBe(1);
  });

  it('房间销毁后原对端可以重新建房', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    reg.create('AAAA', a);
    reg.join('AAAA', b);
    reg.leave('b');
    reg.leave('a');

    const res = reg.create('AAAA', b);

    expect(res.ok).toBe(true);
    expect(reg.roomOf('b')).toBe('AAAA');
  });
});

describe('RoomRegistry 信令转发对象', () => {
  it('others 只返回同房间的其他成员', () => {
    const reg = new RoomRegistry();
    const a = fakeClient('a');
    const b = fakeClient('b');
    const c = fakeClient('c');
    reg.create('AAAA', a);
    reg.join('AAAA', b);
    reg.create('BBBB', c);

    expect(reg.others('AAAA', 'a').map((p) => p.id)).toEqual(['b']);
    expect(reg.others('BBBB', 'a')).toHaveLength(1);
    expect(reg.others('ZZZZ', 'a')).toEqual([]);
  });
});
