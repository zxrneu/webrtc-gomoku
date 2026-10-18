/**
 * 连接码编解码与高压缩模块（deflate-raw + base64url）
 *
 * 【为什么需要这个模块？—— 小白科普】：
 * 在 WebRTC 手动连接模式（无信令服务器）下，两个玩家需要通过微信、QQ 或短信互相发送自己的“名片”（SDP 协商文本）。
 * 原始的 SDP 文本通常长达 2KB ~ 4KB，直接复制粘贴到聊天软件里非常容易被截断、换行破坏，或者产生敏感字符被拦截。
 *
 * 本模块的作用：
 * 1. 压缩：使用 Deflate 算法把原始数据压缩为二进制数据（体积缩小 70% 以上）。
 * 2. 转码：将压缩后的二进制转为 URL 安全的 Base64 字符串（只包含 A-Z、a-z、0-9、短横线 -、下划线 _）。
 * 3. 最终效果：把几千字符的 SDP 压缩到 600~700 字符以内，以字母 'Z' 开头，微信/短信单条即可发送，极佳兼容！
 */

import { BLACK, WHITE } from '@webrtc-gomoku/core';
import type { GameMessage } from './types';

// ==========================================
// 1. Base64URL 编解码工具函数
// ==========================================


/**
 * 将二进制字节数组 (Uint8Array) 转换为 URL 安全的 Base64 字符串 (base64url)
 *
 * 【标准 Base64 vs Base64URL 的区别】：
 * - 标准 Base64 包含 '+'、'/' 和末尾的补位 '='，这些符号在 URL 或微信消息中容易被转义或自动识别为链接。
 * - Base64URL 把 '+' 替换为 '-'，'/' 替换为 '_'，并省去末尾冗余的 '='，传输极其安全。
 *
 * @param bytes 待转换的二进制字节数组
 * @returns 转换后的 URL 安全纯文本字符串
 */
export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  // 分块读取大小：0x8000 = 32768 字节
  // 【为什么不直接一次性 apply？】：如果数组过长，String.fromCharCode.apply 会导致浏览器报“函数调用栈溢出”错误 (Maximum call stack size exceeded)
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  // btoa: 浏览器内置将二进制字符串转为 Base64
  // replace: 转为 base64url 并去除末尾补齐的 =
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 将 Base64URL 字符串还原为二进制字节数组 (Uint8Array)
 *
 * @param str Base64URL 格式的字符串
 * @returns 还原出的原始二进制字节数组
 */
export function b64urlToBytes(str: string): Uint8Array {
  // 1. 将 '-' 还原回 '+'，将 '_' 还原回 '/'
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  // 2. 将每个字符的 ASCII 码存入 Uint8Array
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

// ==========================================
// 2. 打包压缩 (pack)
// ==========================================

/**
 * 将任意 JavaScript 对象序列化为 JSON，并用 deflate-raw 压缩成简短连接码
 *
 * @param obj 需要打包的对象（如 WebRTC 的 Offer / Answer SDP 描述）
 * @returns 压缩后的连接码字符串（若压缩成功以 'Z' 开头；若不支持压缩则平稳降级为原始 JSON）
 */
export async function pack<T = unknown>(obj: T): Promise<string> {
  const json = JSON.stringify(obj);

  // 分支 1：现代浏览器环境（现代浏览器内置 CompressionStream Web API）
  if (typeof CompressionStream !== 'undefined') {
    try {
      // 使用 deflate-raw 格式无头压缩，体积最紧凑
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      // 加上 'Z' 前缀，表示这是一个经 Deflate 压缩过的连接码
      return 'Z' + bytesToB64url(buf);
    } catch {
      // 容错兜底：若压缩异常，回退为原始 JSON
      return json;
    }
  }

  // 分支 2：Node.js 服务端/测试环境（使用 Node.js 内置的 zlib 模块）
  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      const zlib = await import('node:zlib');
      const deflated = zlib.deflateRawSync(Buffer.from(json));
      return 'Z' + bytesToB64url(new Uint8Array(deflated));
    } catch {
      return json;
    }
  }

  // 分支 3：极老旧环境兜底：不压缩直接返回原始 JSON
  return json;
}

// ==========================================
// 3. 解包解压 (unpack)
// ==========================================

/**
 * 将接收到的连接码字符串解压并反序列化回原始对象
 *
 * @param str 接收到的连接码字符串（可以是 'Z' 开头的压缩码，也可以是纯 JSON 文本）
 * @returns 解析还原后的 JavaScript 对象
 * @throws 当输入为空或非法格式时抛出 Error
 */
export async function unpack<T = unknown>(str: string): Promise<T> {
  if (typeof str !== 'string' || !str.trim()) {
    throw new Error('Empty connection code');
  }

  const trimmed = str.trim();

  // 如果以 'Z' 开头，说明是经过 deflate 压缩过的连接码
  if (trimmed.startsWith('Z')) {
    const raw = trimmed.slice(1); // 去掉开头的标识符 'Z'
    const bytes = b64urlToBytes(raw);

    // 分支 1：现代浏览器环境（使用 DecompressionStream Web API）
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const stream = new Blob([bytes as unknown as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        const text = await new Response(stream).text();
        return JSON.parse(text) as T;
      } catch {
        // 解压失败则跳过，在最后尝试作为普通 JSON 解析
      }
    }

    // 分支 2：Node.js 环境（使用 zlib 模块解压）
    if (typeof process !== 'undefined' && process.versions?.node) {
      try {
        const zlib = await import('node:zlib');
        const inflated = zlib.inflateRawSync(Buffer.from(bytes));
        return JSON.parse(inflated.toString('utf8')) as T;
      } catch {
        // 解压失败则跳过
      }
    }
  }

  // 兜底分支：如果不是 'Z' 开头，或者解压流程失败，尝试直接作为纯 JSON 字符串解析
  return JSON.parse(trimmed) as T;
}

// ==========================================
// 4. P2P 局内消息双向编解码与强校验 (GameMessage Codec)
// ==========================================

/**
 * 将局内 GameMessage 序列化为规范 JSON 字符串
 */
export function encodeGameMessage(msg: GameMessage): string {
  return JSON.stringify(msg);
}

/**
 * 校验解析出的对象是否为合法的 GameMessage
 */
function validateGameMessage(obj: Record<string, unknown>): GameMessage {
  if (typeof obj.t !== 'string') {
    throw new Error('局内消息缺少字符串类型字段 t');
  }

  switch (obj.t) {
    case 'hello':
      if (typeof obj.name !== 'string') throw new Error('hello 消息缺少合法的 name 字段');
      if (obj.hostColor !== undefined && obj.hostColor !== BLACK && obj.hostColor !== WHITE) {
        throw new Error('hello 消息 hostColor 必须为 1(黑) 或 2(白)');
      }
      return obj as unknown as GameMessage;
    case 'color':
      if (obj.color !== BLACK && obj.color !== WHITE) {
        throw new Error('color 消息 color 字段必须为 1(黑) 或 2(白)');
      }
      return obj as unknown as GameMessage;
    case 'swap-req':
    case 'swap-ok':
    case 'swap-no':
    case 'undo-req':
    case 'undo-ok':
    case 'undo-no':
    case 'restart-req':
    case 'restart-ok':
    case 'restart-no':
    case 'bye':
    case 'ping':
    case 'pong':
      return obj as unknown as GameMessage;
    case 'move':
      if (typeof obj.x !== 'number' || typeof obj.y !== 'number') {
        throw new Error('move 消息缺少有效的坐标 x, y');
      }
      return obj as unknown as GameMessage;
    case 'chat':
      if (typeof obj.text !== 'string') throw new Error('chat 消息缺少合法的 text 字段');
      return obj as unknown as GameMessage;
    case 'sync':
      if (!Array.isArray(obj.moves)) throw new Error('sync 消息缺少 moves 数组');
      return obj as unknown as GameMessage;
    default:
      throw new Error(`未知消息类型: ${String(obj.t)}`);
  }
}

/**
 * 将原始 JSON 字符串反序列化并强校验为合法 GameMessage
 * @param raw 原始输入字符串
 * @returns 校验通过的 GameMessage
 * @throws 格式非法或包含未知字段时抛出明确 Error
 */
export function decodeGameMessage(raw: string): GameMessage {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('消息不能为空');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JSON 解析失败');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('消息必须为非空对象');
  }
  return validateGameMessage(parsed as Record<string, unknown>);
}


