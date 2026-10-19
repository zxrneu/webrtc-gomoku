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

/** 本端实际能力：录音不支持时 audio 位为 false，入口不渲染 */
export function localCapabilities(): Capabilities {
  return { ...LOCAL_CAPABILITIES, audio: LOCAL_CAPABILITIES.audio && isVoiceRuntimeSupported() };
}
