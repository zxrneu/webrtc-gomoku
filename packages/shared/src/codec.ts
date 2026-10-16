/**
 * 连接码编解码（deflate-raw + base64url）
 * 微信传输友好：670 字符以内，无 '+' '/' '=' 特殊符号
 */

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(str: string): Uint8Array {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export async function pack<T = unknown>(obj: T): Promise<string> {
  const json = JSON.stringify(obj);

  // 浏览器与 Node 18+ 均内置 CompressionStream
  if (typeof CompressionStream !== 'undefined') {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      return 'Z' + bytesToB64url(buf);
    } catch {
      return json;
    }
  }

  // Node.js fallback
  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      const zlib = await import('node:zlib');
      const deflated = zlib.deflateRawSync(Buffer.from(json));
      return 'Z' + bytesToB64url(new Uint8Array(deflated));
    } catch {
      return json;
    }
  }

  return json;
}

export async function unpack<T = unknown>(str: string): Promise<T> {
  if (typeof str !== 'string' || !str.trim()) {
    throw new Error('Empty connection code');
  }

  const trimmed = str.trim();

  if (trimmed.startsWith('Z')) {
    const raw = trimmed.slice(1);
    const bytes = b64urlToBytes(raw);
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const stream = new Blob([bytes as unknown as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        const text = await new Response(stream).text();
        return JSON.parse(text) as T;
      } catch {
        // Fallback to JSON.parse below
      }
    }

    if (typeof process !== 'undefined' && process.versions?.node) {
      try {
        const zlib = await import('node:zlib');
        const inflated = zlib.inflateRawSync(Buffer.from(bytes));
        return JSON.parse(inflated.toString('utf8')) as T;
      } catch {
        // Fallback to JSON.parse below
      }
    }
  }

  return JSON.parse(trimmed) as T;
}
