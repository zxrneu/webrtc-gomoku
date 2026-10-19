import { describe, expect, it } from 'vitest';
import { BLACK, create as createGame } from '@webrtc-gomoku/core';
import type { Capabilities, GameMessage } from '@webrtc-gomoku/shared';

import { createOnlineMessageHandler } from '../../src/connection/onlineMessages';

function setup() {
  const chats: string[] = [];
  const frames: GameMessage[] = [];
  const caps: Capabilities[] = [];
  const names: string[] = [];
  const handler = createOnlineMessageHandler({
    setGame: () => {},
    setMyColor: () => {},
    setPeerName: (n) => names.push(n),
    setModal: () => {},
    setManualConnected: () => {},
    addSysMsg: () => {},
    onPeerChat: (t) => chats.push(t),
    onMediaFrame: (m) => frames.push(m),
    onPeerCapabilities: (c) => caps.push(c),
    showToast: () => {},
    isModalOpen: () => false,
    gameRef: { current: createGame() },
    myColorRef: { current: BLACK },
    isHostRef: { current: true },
    swapPhaseRef: { current: 'idle' },
    awaitingColorRef: { current: false },
    connRef: { current: null },
    clientRef: { current: null },
  });
  return { handler, chats, frames, caps, names };
}

describe('onlineMessages：能力协商与富媒体分发', () => {
  it('hello 携带 capabilities → 归一化后交给媒体控制器', () => {
    const { handler, caps, names } = setup();
    handler({ t: 'hello', name: 'Alice', capabilities: { qr: true, file: true, audio: false, video: false } });
    expect(names).toEqual(['Alice']);
    expect(caps).toEqual([{ qr: true, file: true, audio: false, video: false }]);
  });

  it('旧版 hello 无 capabilities → 全 false（入口不出现）', () => {
    const { handler, caps } = setup();
    handler({ t: 'hello', name: 'Old' });
    expect(caps).toEqual([{ qr: false, file: false, audio: false, video: false }]);
  });

  it('五种媒体帧全部转交 onMediaFrame', () => {
    const { handler, frames } = setup();
    handler({ t: 'media-meta', id: 'm', kind: 'file', name: 'a', size: 1, mime: '', chunkSize: 16384, chunks: 1 });
    handler({ t: 'media-chunk', id: 'm', seq: 0, data: 'AA' });
    handler({ t: 'media-end', id: 'm' });
    handler({ t: 'media-cancel', id: 'm' });
    handler({ t: 'media-ack', id: 'm', ok: true, reason: 'accepted' });
    expect(frames.map((f) => f.t)).toEqual(['media-meta', 'media-chunk', 'media-end', 'media-cancel', 'media-ack']);
  });

  it('文本聊天仍走 onPeerChat，不受富媒体改动影响', () => {
    const { handler, chats, frames } = setup();
    handler({ t: 'chat', text: '你好' });
    expect(chats).toEqual(['你好']);
    expect(frames).toHaveLength(0);
  });
});
