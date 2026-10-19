import type { GameMessage } from '@webrtc-gomoku/shared';

import type { MediaChannelPort } from '../../src/media/mediaChannel';

/** 假传输端口：记录所有帧，可编程背压/关闭/指定帧失败 */
export class FakeMediaChannel implements MediaChannelPort {
  readonly sent: GameMessage[] = [];
  buffered = 0;
  open = true;
  /** 这些帧类型发送时返回 false（模拟断链） */
  readonly failOn = new Set<string>();

  isOpen(): boolean {
    return this.open;
  }

  send(msg: GameMessage): boolean {
    if (!this.open) return false;
    if (this.failOn.has(msg.t)) return false;
    this.sent.push(msg);
    return true;
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  onClose(): void {
    /* 测试不依赖关闭事件 */
  }

  ofType<T extends GameMessage['t']>(t: T): Extract<GameMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<GameMessage, { t: T }>[];
  }
}
