import { describe, it, expect } from 'vitest';

import {
  DEFAULT_ICE_SERVERS,
  fetchIceServers,
  type FetchLike,
} from '../src/iceConfig';

/**
 * 构造一个最小的 `Response` 替身，仅提供被测代码用到的字段。
 */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

/** 构造一个 `res.json()` 会抛错的 `Response` 替身。 */
function brokenJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

describe('iceConfig.fetchIceServers', () => {
  it('DEFAULT_ICE_SERVERS 与旧硬编码完全一致', () => {
    expect(DEFAULT_ICE_SERVERS).toEqual([
      { urls: ['stun:stun.qq.com:3478', 'stun:stun.aliyun.com:3478'] },
      { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    ]);
  });

  it('成功：返回服务端下发的 STUN 配置', async () => {
    const payload = { iceServers: [{ urls: ['stun:stun.example.com:3478'] }] };
    const fetchFn: FetchLike = async () => jsonResponse(payload);

    const result = await fetchIceServers(fetchFn);

    expect(result).toEqual(payload.iceServers);
    expect(result[0]!.urls).toEqual(['stun:stun.example.com:3478']);
  });

  it('成功：含 TURN 段时保留 username/credential', async () => {
    const payload = {
      iceServers: [
        {
          urls: [
            'stun:stun.qq.com:3478',
            'stun:stun.aliyun.com:3478',
            'stun:stun1.l.google.com:19302',
            'stun:stun2.l.google.com:19302',
          ],
        },
        { urls: ['turn:turn.example.com:3478'], username: 'user', credential: '***' },
      ],
    };
    const fetchFn: FetchLike = async () => jsonResponse(payload);

    const result = await fetchIceServers(fetchFn);

    expect(result).toEqual(payload.iceServers);
    expect(result[1]).toEqual({
      urls: ['turn:turn.example.com:3478'],
      username: 'user',
      credential: '***',
    });
  });

  it('成功：urls 为单个字符串亦合法', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ iceServers: [{ urls: 'stun:stun.single:3478' }] });

    const result = await fetchIceServers(fetchFn);

    expect(result).toEqual([{ urls: 'stun:stun.single:3478' }]);
  });

  it('降级：fetch reject → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('network down');
    };

    const result = await fetchIceServers(fetchFn);

    expect(result).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：fetch 同步抛错 → DEFAULT', async () => {
    const fetchFn: FetchLike = () => {
      throw new Error('boom');
    };

    const result = await fetchIceServers(fetchFn);

    expect(result).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：非 2xx 404 → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({}, { ok: false, status: 404 });

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：非 2xx 500 → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({}, { ok: false, status: 500 });

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：JSON 解析失败 → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => brokenJsonResponse();

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：iceServers 缺失 → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({});

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：iceServers 为空数组 → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ iceServers: [] });

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：iceServers 非数组 → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ iceServers: 'oops' });

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：元素缺少 urls → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ iceServers: [{ username: 'u' }] });

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：urls 为空数组 → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ iceServers: [{ urls: [] }] });

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：urls 类型非法（number）→ DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ iceServers: [{ urls: 123 }] });

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：响应体为 null → DEFAULT', async () => {
    const fetchFn: FetchLike = async () => jsonResponse(null);

    expect(await fetchIceServers(fetchFn)).toBe(DEFAULT_ICE_SERVERS);
  });

  it('降级：超时（fetch 永不 resolve）→ DEFAULT', async () => {
    const fetchFn: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });

    const result = await fetchIceServers(fetchFn, { timeoutMs: 5 });

    expect(result).toBe(DEFAULT_ICE_SERVERS);
  });

  it('向 fetch 传入 AbortSignal（供超时中止）', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const fetchFn: FetchLike = async (_input, init) => {
      capturedSignal = init?.signal;
      return jsonResponse({ iceServers: [{ urls: ['stun:x:3478'] }] });
    };

    await fetchIceServers(fetchFn);

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('默认请求路径为 /config', async () => {
    let capturedInput: string | null = null;
    const fetchFn: FetchLike = async (input) => {
      capturedInput = input;
      return jsonResponse({ iceServers: [{ urls: ['stun:x:3478'] }] });
    };

    await fetchIceServers(fetchFn);

    expect(capturedInput).toBe('/config');
  });
});
