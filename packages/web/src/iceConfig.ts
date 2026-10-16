/**
 * ICE 配置获取与降级（单一职责）。
 *
 * 本模块只做一件事：从信令服务器的 `GET /config` 端点拉取 `iceServers`，
 * 并在任何异常情况下**静默降级**到内置 STUN 列表。它不关心 WebRTC 连接、
 * 对局协议或界面逻辑。
 *
 * 设计要点（对齐 AGENTS.md）：
 * - 依赖反转：`fetchFn` 通过参数注入，单测无需真实网络。
 * - 产品第一原则：`fetchIceServers` **永不抛异常**，失败即返回降级值，
 *   保证「零服务器 + 微信互发连接码」保底路径不受影响。
 */

/**
 * 内置降级 STUN 列表。
 *
 * 内容必须与旧版 `packages/web/src/webrtc.ts` 中的硬编码 `ICE_SERVERS`
 * **完全一致**（腾讯 + 阿里优先，Google 备用），作为 `/config` 不可用时的兜底。
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.qq.com:3478', 'stun:stun.aliyun.com:3478'] },
  { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
];

/** 默认请求超时（毫秒）。超时后中止请求并降级，避免阻塞建连。 */
export const DEFAULT_ICE_FETCH_TIMEOUT_MS = 3000;

/** 默认 `/config` 端点路径（与信令服务器同源）。 */
export const DEFAULT_ICE_CONFIG_PATH = '/config';

/**
 * 注入式 fetch 契约。
 *
 * 刻意只声明 `string` 入参，便于单测传入极简替身；真实 `globalThis.fetch`
 * 满足该签名（其 `RequestInfo | URL` 入参兼容 `string`）。
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `fetchIceServers` 的可选参数。 */
export interface FetchIceServersOptions {
  /** `/config` 端点路径，默认 {@link DEFAULT_ICE_CONFIG_PATH}。 */
  url?: string;
  /** 请求超时毫秒数，默认 {@link DEFAULT_ICE_FETCH_TIMEOUT_MS}。 */
  timeoutMs?: number;
}

/**
 * 从 `GET /config` 拉取服务端下发的 ICE 配置。
 *
 * 返回语义：
 * - 成功：返回服务端下发的 `RTCIceServer[]`（可能含 TURN 段）。
 * - 任何异常（网络错误 / 抛错 / 非 2xx / 超时 / JSON 解析失败 /
 *   `iceServers` 缺失或非非空数组 / 元素结构非法）：返回
 *   {@link DEFAULT_ICE_SERVERS}，**不抛异常**。
 *
 * @param fetchFn 注入的 fetch 实现，默认包裹 `globalThis.fetch`（保留 this 绑定）。
 * @param options 端点路径与超时配置。
 * @returns 可安全传入 `new RTCPeerConnection({ iceServers })` 的数组。
 */
export async function fetchIceServers(
  fetchFn: FetchLike = (input, init) => globalThis.fetch(input, init),
  options: FetchIceServersOptions = {},
): Promise<RTCIceServer[]> {
  const url = options.url ?? DEFAULT_ICE_CONFIG_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ICE_FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) {
      return DEFAULT_ICE_SERVERS;
    }
    const data: unknown = await res.json();
    return extractIceServers(data) ?? DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 校验并提取响应体中的 `iceServers`。
 *
 * @param data 已解析的 JSON 响应体。
 * @returns 合法的 `RTCIceServer[]`；结构不合法时返回 `null`。
 */
function extractIceServers(data: unknown): RTCIceServer[] | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const iceServers = (data as Record<string, unknown>)['iceServers'];
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    return null;
  }

  const servers: RTCIceServer[] = [];
  for (const entry of iceServers) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const urls = (entry as Record<string, unknown>)['urls'];
    if (!isValidUrls(urls)) {
      return null;
    }
    // 结构合法，原样透传以保留 TURN 的 username/credential 等可选字段。
    servers.push(entry as unknown as RTCIceServer);
  }
  return servers;
}

/**
 * 判断 `urls` 是否为合法的非空 STUN/TURN 地址（`string` 或非空 `string[]`）。
 *
 * @param urls 待校验值。
 * @returns 合法返回 `true`。
 */
function isValidUrls(urls: unknown): boolean {
  if (typeof urls === 'string') {
    return urls.length > 0;
  }
  if (Array.isArray(urls)) {
    return urls.length > 0 && urls.every((u) => typeof u === 'string' && u.length > 0);
  }
  return false;
}
