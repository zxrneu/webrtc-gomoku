/**
 * 富媒体错误/提示文案的唯一映射表（组件不拼文案）。
 */
import type { MediaRejectReason } from '@webrtc-gomoku/shared';

const REJECT_TEXT: Record<MediaRejectReason, string> = {
  'too-large': '文件超过 500MB，暂不支持发送',
  'executable-ext': '出于安全考虑，暂不支持发送可执行文件',
  'mime-mismatch': '文件类型与扩展名不符，已取消发送',
  'empty-name': '文件名为空，无法发送',
  'bad-chunk-size': '分片参数异常，已取消发送',
};

/** 发送前校验失败的中文提示 */
export function rejectText(reason: MediaRejectReason): string {
  return REJECT_TEXT[reason] ?? '文件校验失败，已取消发送';
}

const TRANSFER_FAIL_TEXT: Record<string, string> = {
  'channel-closed': '连接已断开，传输失败',
  'send-error': '发送失败，请检查连接状态',
  aborted: '传输已取消',
  timeout: '长时间未收到数据，传输已失败',
  incomplete: '数据不完整，传输已失败',
  'size-mismatch': '文件大小校验失败，已丢弃',
  'invalid-meta': '文件信息异常，已拒绝接收',
  'rejected-size': '已拒绝接收该文件',
  'rejected-type': '文件类型不被允许',
  unsupported: '对方不支持该功能',
};

/** 传输失败原因的中文提示 */
export function transferFailText(reason: string): string {
  return TRANSFER_FAIL_TEXT[reason] ?? '传输失败';
}

/** 接收大文件的确认文案 */
export function largeFileConfirmText(name: string, sizeText: string): string {
  return `对方想发送「${name}」（${sizeText}）。接收会占用带宽，是否接收？`;
}
