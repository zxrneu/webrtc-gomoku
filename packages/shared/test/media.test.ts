import { describe, it, expect } from 'vitest';
import {
  ALL_CAPABILITIES_OFF,
  MEDIA_CHUNK_SIZE,
  MEDIA_MAX_BYTES,
  detectRenderKind,
  extensionOf,
  formatBytes,
  hasBlockedExtension,
  makeMediaId,
  negotiateCapabilities,
  normalizeCapabilities,
  planChunks,
  sanitizeFileName,
  validateFilePayload,
  computeSha256,
} from '../src/index';

describe('能力协商（N1）', () => {
  it('旧版对端缺少 capabilities → 全 false', () => {
    expect(normalizeCapabilities(undefined)).toEqual(ALL_CAPABILITIES_OFF);
    expect(normalizeCapabilities(null)).toEqual(ALL_CAPABILITIES_OFF);
  });

  it('非布尔字段一律按 false 处理', () => {
    expect(normalizeCapabilities({ qr: 'yes', file: 1, audio: true, video: false })).toEqual({
      qr: false,
      file: false,
      audio: true,
      video: false,
    });
  });

  it('双方取交集控制入口显隐', () => {
    const local = { qr: true, file: true, audio: true, video: false };
    const remote = { qr: false, file: true, audio: false, video: true };
    expect(negotiateCapabilities(local, remote)).toEqual({ qr: false, file: true, audio: false, video: false });
  });
});

describe('分片计划', () => {
  it('空文件按 1 片处理', () => {
    expect(planChunks(0)).toBe(1);
  });

  it('整除与余数都向上取整', () => {
    expect(planChunks(32 * 1024)).toBe(1);
    expect(planChunks(32 * 1024 + 1)).toBe(2);
    expect(planChunks(100 * 1024, 16 * 1024)).toBe(7);
  });

  it('非法参数抛错', () => {
    expect(() => planChunks(-1)).toThrow();
    expect(() => planChunks(10, 0)).toThrow();
  });
});

describe('文件名校验与清洗', () => {
  it('去掉路径与控制字符并限长', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeFileName('   ')).toBe('未命名文件');
    expect(sanitizeFileName('x'.repeat(300)).length).toBe(200);
  });

  it('识别扩展名与黑名单', () => {
    expect(extensionOf('a.PNG')).toBe('.png');
    expect(extensionOf('noext')).toBe('');
    expect(hasBlockedExtension('virus.EXE')).toBe(true);
    expect(hasBlockedExtension('photo.jpg')).toBe(false);
  });

  it('可执行文件、超限、空名被拒绝', () => {
    expect(validateFilePayload({ name: 'a.exe', mime: 'application/octet-stream', size: 10 }).ok).toBe(false);
    expect(validateFilePayload({ name: 'a.bin', mime: '', size: MEDIA_MAX_BYTES + 1 }).ok).toBe(false);
    expect(validateFilePayload({ name: '   ', mime: '', size: 1 }).ok).toBe(false);
  });

  it('上限锁定为 500MB：恰好 500MB 放行，多 1 字节拒绝', () => {
    expect(MEDIA_MAX_BYTES).toBe(500 * 1024 * 1024);
    expect(validateFilePayload({ name: 'a.bin', mime: '', size: MEDIA_MAX_BYTES })).toEqual({ ok: true });
    expect(validateFilePayload({ name: 'a.bin', mime: '', size: MEDIA_MAX_BYTES + 1 })).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('500MB 分片计划仍是整数片且末片对齐', () => {
    const plan = planChunks(MEDIA_MAX_BYTES, MEDIA_CHUNK_SIZE.DEFAULT);
    expect(plan).toBe(Math.ceil(MEDIA_MAX_BYTES / MEDIA_CHUNK_SIZE.DEFAULT));
    expect(Number.isInteger(plan)).toBe(true);
  });

  it('图片扩展名与 MIME 不符时拒绝', () => {
    const res = validateFilePayload({ name: 'fake.png', mime: 'text/html', size: 10 });
    expect(res).toEqual({ ok: false, reason: 'mime-mismatch' });
  });

  it('合法文件通过校验', () => {
    expect(validateFilePayload({ name: 'photo.jpg', mime: 'image/jpeg', size: 1024 }).ok).toBe(true);
    expect(validateFilePayload({ name: 'notes.pdf', mime: 'application/pdf', size: 1024 }).ok).toBe(true);
  });

  it('分片大小越界被拒绝', () => {
    const res = validateFilePayload({ name: 'a.bin', mime: '', size: 10, chunkSize: MEDIA_CHUNK_SIZE.MAX + 1 });
    expect(res).toEqual({ ok: false, reason: 'bad-chunk-size' });
  });
});

describe('渲染类型兜底', () => {
  it('声称图片但不像图片 → 回落文件卡片', () => {
    expect(detectRenderKind('image', 'x.bin', 'application/octet-stream')).toBe('file');
    expect(detectRenderKind('image', 'x.png', 'image/png')).toBe('image');
    expect(detectRenderKind('file', 'x.png', 'image/png')).toBe('file');
    expect(detectRenderKind('audio', 'voice.webm', 'audio/webm')).toBe('audio');
  });

  it('声称图片但为 SVG 时降级为文件卡片（防在新标签打开执行内嵌同源脚本）', () => {
    expect(detectRenderKind('image', 'vector.svg', 'image/svg+xml')).toBe('file');
    expect(detectRenderKind('image', 'vector.svg', '')).toBe('file');
    expect(detectRenderKind('image', 'vector.SVG', 'image/svg+xml')).toBe('file');
    expect(detectRenderKind('image', 'drawing', 'image/svg+xml')).toBe('file');
  });
});

describe('媒体 ID 与格式化', () => {
  it('ID 可复现（随机源注入）', () => {
    const id1 = makeMediaId(() => 0.5);
    const id2 = makeMediaId(() => 0.5);
    expect(id1).toBe(id2);
    expect(id1.startsWith('m')).toBe(true);
    expect(makeMediaId(() => 0.1)).not.toBe(makeMediaId(() => 0.9));
  });

  it('大小格式化', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(820)).toBe('820 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB');
  });

  it('SHA-256 哈希计算正确且确定', async () => {
    const hash = await computeSha256(new TextEncoder().encode('hello'));
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    const emptyHash = await computeSha256(new Uint8Array(0));
    expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('当 Web Crypto 不可用时，纯 JS 降级仍返回完全相同的标准 64 位 SHA-256', async () => {
    const originalCrypto = globalThis.crypto;
    try {
      // 模拟无 Web Crypto 的环境
      Object.defineProperty(globalThis, 'crypto', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const hash = await computeSha256(new TextEncoder().encode('hello'));
      expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
      const emptyHash = await computeSha256(new Uint8Array(0));
      expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    }
  });
});
