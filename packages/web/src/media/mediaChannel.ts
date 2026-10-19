/**
 * 富媒体传输端口（DIP 接缝）。
 *
 * 发送器/接收器只依赖本接口，单测注入假实现即可，不启动真实网络
 * （沙箱无真实 ICE，e2e 会降级）。
 */
import type { GameMessage } from '@webrtc-gomoku/shared';

export interface MediaChannelPort {
  /** 数据通道是否可写 */
  isOpen(): boolean;
  /** 发送一帧；返回 false 表示通道已断 */
  send(msg: GameMessage): boolean;
  /** 当前发送缓冲字节数（流控用） */
  bufferedAmount(): number;
  /** 通道关闭通知（用 addEventListener，不覆盖 webrtc.ts 的 onclose 属性） */
  onClose(cb: () => void): void;
}

/** 把浏览器 RTCDataChannel 适配成端口 */
export function createDcMediaChannel(dc: RTCDataChannel): MediaChannelPort {
  return {
    isOpen: () => dc.readyState === 'open',
    send: (msg: GameMessage): boolean => {
      if (dc.readyState !== 'open') return false;
      try {
        dc.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    },
    bufferedAmount: () => dc.bufferedAmount,
    onClose: (cb: () => void): void => {
      dc.addEventListener('close', cb);
    },
  };
}
