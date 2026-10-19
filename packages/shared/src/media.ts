/**
 * 富媒体聊天的纯逻辑层（shared，零 IO / 零 DOM）
 *
 * 职责边界：
 * - 常量唯一出处（分片大小、大小上限、流控阈值、录音上限）；
 * - 能力协商（旧版无字段 → 全 false）；
 * - 文件安全校验（扩展名黑名单 + MIME 合理性）与文件名清洗；
 * - 分片计划、媒体 ID 生成（随机源注入，可复现单测）。
 *
 * 浏览器 API（Blob / MediaRecorder / RTCDataChannel）一律不进本文件。
 */

import type { Capabilities, MediaKind } from './types';

/** 分片大小（字节）：默认 32KB，允许 16–64KB */
export const MEDIA_CHUNK_SIZE = { DEFAULT: 32 * 1024, MIN: 16 * 1024, MAX: 64 * 1024 } as const;

/**
 * 单文件硬上限：>500MB 发送前直接拒绝（两侧同一条红线，接收侧在 media-meta 上复核，遵循 PRD R-P0-3）
 *
 * 为什么是 500MB：
 * - 发送端与接收端都按「内存 Blob」实现，500MB 在各端浏览器稳妥无 OOM 风险；
 * - 32KB 分片下 500MB = 16000 片，分片计划 / 进度 / 重组是可接受的量级。
 */
export const MEDIA_MAX_BYTES = 500 * 1024 * 1024;

/** <50MB 自动接收；≥50MB 需要接收方确认 */
export const MEDIA_AUTO_ACCEPT_BYTES = 50 * 1024 * 1024;

/** >100MB 提示网络环境（局域网/IPv6 体验更佳） */
export const MEDIA_LARGE_HINT_BYTES = 100 * 1024 * 1024;

/** 流控：缓冲高于 PAUSE_ABOVE 暂停，低于 RESUME_BELOW 续传 */
export const MEDIA_FLOW_CONTROL = {
  PAUSE_ABOVE: 4 * 1024 * 1024,
  RESUME_BELOW: 1 * 1024 * 1024,
  POLL_MS: 50,
} as const;

/** 语音消息录音上限（毫秒） */
export const VOICE_MAX_MS = 60_000;

/** 进度超时：15s 没有新分片即判定失败（避免对端消失后无限等待） */
export const MEDIA_PROGRESS_TIMEOUT_MS = 15_000;

/** 确认超时：大文件弹窗等待用户确认的独立超时上限（60s） */
export const MEDIA_CONFIRM_TIMEOUT_MS = 60_000;

/** 文件名最大展示长度 */
export const MEDIA_NAME_MAX = 200;

/** 能力全关（旧版对端 / 未协商） */
export const ALL_CAPABILITIES_OFF: Capabilities = { qr: false, file: false, audio: false, video: false };

/** 拒绝原因（web 层映射为中文文案） */
export type MediaRejectReason = 'too-large' | 'executable-ext' | 'mime-mismatch' | 'empty-name' | 'bad-chunk-size';

/** 可执行/高风险扩展名黑名单（双端校验；扩展名可伪造，故仅作为一层防御） */
const BLOCKED_EXTENSIONS: readonly string[] = [
  '.exe', '.bat', '.cmd', '.apk', '.sh', '.msi', '.scr', '.com', '.vbs', '.ps1', '.jar', '.dll',
];

/** 图片扩展名（用于图片 MIME 兜底判定） */
const IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'];

/** 取小写扩展名（含点）；无扩展名返回空串 */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx).toLowerCase();
}

/** 是否为黑名单可执行扩展名 */
export function hasBlockedExtension(name: string): boolean {
  return BLOCKED_EXTENSIONS.includes(extensionOf(name));
}

/**
 * 归一化能力集：任何非对象 / 缺字段 / 非布尔值都按 false 处理。
 * 旧版 hello 没有该字段时，调用方传 undefined 即得全 false。
 */
export function normalizeCapabilities(raw: unknown): Capabilities {
  if (typeof raw !== 'object' || raw === null) return { ...ALL_CAPABILITIES_OFF };
  const r = raw as Record<string, unknown>;
  return {
    qr: r.qr === true,
    file: r.file === true,
    audio: r.audio === true,
    video: r.video === true,
  };
}

/** 双方能力取交集（功能入口显隐的唯一判据） */
export function negotiateCapabilities(local: Capabilities, remote: Capabilities): Capabilities {
  return {
    qr: local.qr && remote.qr,
    file: local.file && remote.file,
    audio: local.audio && remote.audio,
    video: local.video && remote.video,
  };
}

/** 分片数 = ceil(size / chunkSize)；空文件按 1 片处理（发送一个空分片） */
export function planChunks(size: number, chunkSize: number = MEDIA_CHUNK_SIZE.DEFAULT): number {
  if (!Number.isFinite(size) || size < 0) throw new Error('文件大小非法');
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error('分片大小非法');
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** 清洗文件名：去路径、控制字符、首尾空白，并限制长度；空名给默认值 */
export function sanitizeFileName(name: string, fallback = '未命名文件'): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop() ?? '';
  // 去掉 C0/C1 控制字符（含换行、制表、DEL）
  const cleaned = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, MEDIA_NAME_MAX);
}

/** 扩展名黑名单 + MIME 合理性 + 大小上限；图片 MIME 与扩展名明显不符时拒绝 */
export function validateFilePayload(input: {
  name: string;
  mime: string;
  size: number;
  chunkSize?: number;
}): { ok: true } | { ok: false; reason: MediaRejectReason } {
  const name = sanitizeFileName(input.name, '');
  if (!name) return { ok: false, reason: 'empty-name' };
  if (!Number.isFinite(input.size) || input.size < 0 || input.size > MEDIA_MAX_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  if (hasBlockedExtension(name)) return { ok: false, reason: 'executable-ext' };

  const chunkSize = input.chunkSize ?? MEDIA_CHUNK_SIZE.DEFAULT;
  if (chunkSize < MEDIA_CHUNK_SIZE.MIN || chunkSize > MEDIA_CHUNK_SIZE.MAX) {
    return { ok: false, reason: 'bad-chunk-size' };
  }

  const mime = (input.mime || '').toLowerCase();
  const ext = extensionOf(name);
  const looksImageByExt = IMAGE_EXTENSIONS.includes(ext);
  const looksImageByMime = mime.startsWith('image/');
  if (looksImageByExt && mime && !looksImageByMime) return { ok: false, reason: 'mime-mismatch' };
  return { ok: true };
}

/** 是否为 SVG 文件（扩展名或 MIME） */
export function isSvg(name: string, mime?: string): boolean {
  const ext = extensionOf(name);
  const m = (mime || '').toLowerCase();
  return ext === '.svg' || m === 'image/svg+xml' || m.includes('svg');
}

/**
 * 渲染类型兜底：
 * - 声称图片但为 SVG 时降级为文件卡片（SVG 原图在新标签打开可执行内嵌脚本，同源 XSS 防御）；
 * - 声称图片但 MIME/扩展名都不像图片时回落为文件卡片，避免把任意字节塞进 <img> 造成破图或意外解析。
 */
export function detectRenderKind(kind: MediaKind, name: string, mime: string): MediaKind {
  if (kind !== 'image') return kind;
  if (isSvg(name, mime)) return 'file';
  const looksImage = (mime || '').toLowerCase().startsWith('image/') || IMAGE_EXTENSIONS.includes(extensionOf(name));
  return looksImage ? 'image' : 'file';
}

/** 生成媒体会话 ID（随机源可注入，便于测试复现） */
export function makeMediaId(random: () => number = Math.random): string {
  const a = Math.floor(random() * 0x100000000).toString(36);
  const b = Math.floor(random() * 0x100000000).toString(36);
  return `m${a}${b}`;
}

/** 人类可读大小（1.5 MB / 820 B） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${text} ${units[unit]}`;
}

/** SHA-256 轮常量（前 64 个素数的立方根小数部分前 32 位） */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotr32(n: number, b: number): number {
  return (n >>> b) | (n << (32 - b));
}

/** 纯 TS/JS 标准 SHA-256 实现（FIPS 180-4 / RFC 6234，用于无 Web Crypto 环境下的精准一致降级） */
export function pureJsSha256(data: Uint8Array): string {
  const len = data.length;
  const padLen = len % 64 < 56 ? 56 - (len % 64) : 120 - (len % 64);
  const totalLen = len + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  // 写入 64 位大端消息比特长度
  view.setUint32(totalLen - 8, Math.floor(len / 0x20000000) >>> 0);
  view.setUint32(totalLen - 4, (len * 8) >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let i = 0; i < totalLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr32(w[t - 15]!, 7) ^ rotr32(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr32(w[t - 2]!, 17) ^ rotr32(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[t]! + w[t]!) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

/** 计算二进制数据的 SHA-256 哈希（十六进制字符串，带环境一致性纯 JS 算法降级） */
export async function computeSha256(data: Uint8Array): Promise<string> {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    try {
      const copy = data.slice();
      const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
      const array = new Uint8Array(digest);
      return Array.from(array)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // 若 Web Crypto 偶发异常则降级到纯 JS SHA-256
    }
  }
  return pureJsSha256(data);
}
