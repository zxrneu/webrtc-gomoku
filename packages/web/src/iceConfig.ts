/**
 * ICE 网络穿透配置获取与优雅降级模块（单一职责原则 SRP）
 *
 * 【为什么需要这个模块？—— 小白科普】：
 * 1. 什么是 ICE / STUN / TURN？
 *    - 两个玩家想要直接通过 WebRTC 连线，通常双方都在家庭路由器/WiFi 内网（NAT）后面。
 *    - STUN 服务器像一面“镜子”，帮两端照出自己在公网上的映射 IP 与端口，用来“打洞”（NAT 穿透）；
 *    - TURN 服务器则是打洞彻底失败时的“中继代发服务器”。
 * 2. 传统写法的硬伤：
 *    - 要么在前端代码里把 STUN 地址写死（万一服务器失效就全挂了，且无法动态下发敏感的 TURN 账号密码）；
 *    - 要么每次开局强制等后端接口返回（如果后端宕机，前端跟着卡死白屏）。
 * 3. 本模块的解法：
 *    - 动态嗅探：网页启动后向信令服务 `GET /config` 动态拉取最新的 STUN/TURN；
 *    - 优雅降级（Graceful Degradation）：无论发生网络断开、超时（>3秒）、404/500、还是 JSON 畸形，
 *      **本函数绝对不抛出任何异常**，始终静默返回内置的国内高可用 STUN 列表，保证无网单机与微信邀请模式 100% 畅通！
 */

/**
 * 内置降级默认 STUN 服务器列表
 *
 * 【网络优化策略】：
 * - 腾讯云与阿里云国内节点优先：延迟通常在 10~30ms 以内，内网打洞极快；
 * - Google 官方全球节点备用：保证海外玩家也能顺畅连接。
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.qq.com:3478', 'stun:stun.aliyun.com:3478'] },
  { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
];

/**
 * 默认请求超时时间（3000 毫秒 / 3 秒）
 * 超时后主动中断 HTTP 请求并直接降级，绝不阻塞用户的对局建连体验
 */
export const DEFAULT_ICE_FETCH_TIMEOUT_MS = 3000;

/**
 * 默认信令服务配置接口相对路径（与当前前端网页同源）
 */
export const DEFAULT_ICE_CONFIG_PATH = '/config';

/**
 * 注入式 Fetch 函数签名类型（SOLID 原则之“依赖反转 DIP”）
 *
 * 【测试架构技巧】：
 * 为什么不直接在代码里硬编码 `fetch(...)`？
 * 因为单元测试如果在 Node 环境跑真实网络请求会不稳定且慢。
 * 通过入参注入 `fetchFn`，单测可以传入一个瞬间返回 Mock 数据的假 fetch，
 * 毫秒级模拟出超时、网络崩溃、500 报错等全部 19 种极端分支！
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * fetchIceServers 函数的可选参数选项
 */
export interface FetchIceServersOptions {
  /** 目标配置端点路径，默认 '/config' */
  url?: string;
  /** 请求超时毫秒数，默认 3000ms */
  timeoutMs?: number;
}

/**
 * 从服务端 `GET /config` 异步拉取 ICE 网络配置
 *
 * 【核心设计契约】：
 * 1. 成功分支：返回服务端下发的 `RTCIceServer[]`（包含公网 STUN 以及带账密的专用 TURN 服务器）；
 * 2. 失败分支：任何异常（网络断开、超时、状态码非 2xx、JSON 损坏、结构不合法）
 *    **均在内部吞掉并返回 DEFAULT_ICE_SERVERS，永不让外层崩溃**！
 *
 * @param fetchFn 依赖注入的 fetch 实现，默认包裹全局 `globalThis.fetch`
 * @param options 请求配置（端点路径与超时时长）
 * @returns 保证永远合法、可直接传给 `new RTCPeerConnection({ iceServers })` 的服务器数组
 */
export async function fetchIceServers(
  fetchFn: FetchLike = (input, init) => globalThis.fetch(input, init),
  options: FetchIceServersOptions = {},
): Promise<RTCIceServer[]> {
  const url = options.url ?? DEFAULT_ICE_CONFIG_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ICE_FETCH_TIMEOUT_MS;

  // 现代浏览器超时控制：使用 AbortController
  const controller = new AbortController();
  // 超过 timeoutMs 毫秒自动发出 abort 中止信号
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. 发起 HTTP 请求，并绑定超时中止信号 signal
    const res = await fetchFn(url, { signal: controller.signal });
    
    // 2. HTTP 状态码校验：如果不是 200~299（如 404 或 500），立即降级
    if (!res.ok) {
      return DEFAULT_ICE_SERVERS;
    }

    // 3. 提取 JSON 数据并进行严格运行时结构校验
    const data: unknown = await res.json();
    return extractIceServers(data) ?? DEFAULT_ICE_SERVERS;
  } catch {
    // 4. 兜底所有异常（包含 AbortError 超时、网络无法连接等），安全降级
    return DEFAULT_ICE_SERVERS;
  } finally {
    // 无论成功还是失败，务必清除定时器，防止 Node.js 测试环境进程挂起
    clearTimeout(timer);
  }
}

/**
 * 校验并提取响应体中的 `iceServers` 列表（运行时防御性类型收窄）
 *
 * 【安全编程规范】：
 * 从网络接收到的数据是 `unknown`，绝不能直接盲信强制转换为目标类型！
 * 必须自顶向下严格验证：是不是对象？有没有 iceServers？是不是非空数组？每一项格式对不对？
 *
 * @param data 解析后的未知 JSON 数据
 * @returns 验证通过的合法 RTCIceServer 数组；若格式畸变则返回 null
 */
function extractIceServers(data: unknown): RTCIceServer[] | null {
  // 校验 1：根节点必须是非 null 的对象
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  // 校验 2：必须包含 iceServers 字段且必须是非空数组
  const iceServers = (data as Record<string, unknown>)['iceServers'];
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    return null;
  }

  const servers: RTCIceServer[] = [];
  // 校验 3：遍历数组中每个节点
  for (const entry of iceServers) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    // 每一个 entry 内部必须包含合法的 urls 字段
    const urls = (entry as Record<string, unknown>)['urls'];
    if (!isValidUrls(urls)) {
      return null;
    }
    // 校验通过：原样保留该项（从而自动保留 TURN 所需的 username 和 credential 等扩展字段）
    servers.push(entry as unknown as RTCIceServer);
  }
  return servers;
}

/**
 * 校验 urls 字段是否为合法的非空 STUN/TURN 地址
 *
 * WebRTC 规范允许 urls 是两种格式：
 * 1. 单个字符串：`"stun:stun.l.google.com:19302"`
 * 2. 字符串数组：`["stun:stun1.com", "stun:stun2.com"]`
 *
 * @param urls 待检查的未知数据
 * @returns true 表示合法，false 表示非法
 */
function isValidUrls(urls: unknown): boolean {
  // 格式 1：单字符串，且不能为空
  if (typeof urls === 'string') {
    return urls.length > 0;
  }
  // 格式 2：数组，且必须非空，且每一项都必须是非空字符串
  if (Array.isArray(urls)) {
    return urls.length > 0 && urls.every((u) => typeof u === 'string' && u.length > 0);
  }
  return false;
}

