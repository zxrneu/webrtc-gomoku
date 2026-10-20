/**
 * 本端能力集与运行时检测。
 *
 * `file` 覆盖图片 + 文件；`audio` 本期表示「语音消息」能力（实时通话另属 F3）。
 */
import type { Capabilities } from '@webrtc-gomoku/shared';

/** 静态能力集（录音运行时支持另行检测） */
export const LOCAL_CAPABILITIES: Capabilities = { qr: true, file: true, audio: true, video: false };

/** 当前运行时能否录音（getUserMedia + MediaRecorder 都存在才算支持，R3 降级判据） */
export function isVoiceRuntimeSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const hasGetUserMedia = !!navigator.mediaDevices?.getUserMedia;
  const hasRecorder = typeof MediaRecorder !== 'undefined';
  return hasGetUserMedia && hasRecorder;
}

/** 本端实际能力：录音不支持时 audio 位为 false，界面说明不可用原因。 */
export function localCapabilities(): Capabilities {
  return { ...LOCAL_CAPABILITIES, audio: LOCAL_CAPABILITIES.audio && isVoiceRuntimeSupported() };
}

/** 语音入口始终可发现，并明确说明当前无法录制的原因。 */
export function voiceMessageUnavailableReason(options: {
  connected: boolean;
  secureContext: boolean;
  localAudio: boolean;
  peerAudio: boolean | null;
}): string | undefined {
  if (!options.connected) return '请先连接对手，再发送语音消息';
  if (!options.secureContext) return '语音消息需要 HTTPS，请通过 HTTPS 打开页面';
  if (!options.localAudio) return '当前浏览器不支持录音，请使用支持录音的浏览器';
  if (options.peerAudio === null) return '正在确认对方是否支持语音消息';
  if (!options.peerAudio) return '对方当前不支持语音消息';
  return undefined;
}
