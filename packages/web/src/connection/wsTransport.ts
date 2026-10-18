/**
 * ============================================================================
 * 信令通道适配器（`SignalTransport` 的浏览器实现）
 * ============================================================================
 * 职责：把浏览器 `WebSocket` 的「回调式 API」翻译成 `shared` 编排器认识的
 * **纯事件流**（`SignalEvent`），并承担两件 `shared` 不允许做的事：
 *
 * ① **L2 应用层心跳**：每 5s 发 `{t:'ping'}`，3s 内无 `pong` 记一次 miss，
 *    连续 2 次 miss 判定「半开连接已死」（对齐 PRD M4 ≤16s）。
 * ② **旧服务端兼容探测（K8-2）**：v1 服务端不认识 `ping` / `resume`，
 *    会回一条 `{t:'error', message:'未知消息类型'}`。此时**绝不能**把它当普通错误
 *    上报（否则业务层会弹「未知消息类型」），也不能继续发心跳（会无限刷错误）。
 *    正确做法是：emit `probe-unsupported`，关闭心跳，让编排器降级为 v1 流程。
 *
 * 红线（AGENTS §5）：
 * - 本文件不打印任何日志（日志出口只有 `logger.ts`）；
 * - 不缓存、不上报 SDP / ICE candidate / token 到日志（本文件压根不碰日志）。
 */

import type {
  ClientSignalingMsg,
  Clock,
  HeartbeatState,
  ReconnectPolicy,
  ServerSignalingMsg,
  SignalEvent,
  SignalTransport,
} from '@webrtc-gomoku/shared';
import {
  createHeartbeat,
  evaluate,
  isUnsupportedMessageError,
  markPong,
  markSent,
} from '@webrtc-gomoku/shared';

/** 适配器可注入的构造参数 */
export interface WsTransportOptions {
  /** 注入时钟（单测用假时钟，生产用 `systemClock`） */
  clock: Clock;
  /** 策略参数（心跳间隔 / 超时 / miss 阈值都从这里读，禁止写字面量） */
  policy: ReconnectPolicy;
  /** 可选的 socket 工厂（单测替身 / SSR 场景）；默认 `new WebSocket(url)` */
  socketFactory?: (url: string) => WebSocket;
}

/** 内部维护的连接状态（比 `WebSocket.readyState` 更贴近本适配器语义） */
type TransportState = 'idle' | 'connecting' | 'open' | 'closed';

/** 判定「这是不是一个探测报文」的来源类型 */
type ProbeSource = 'ping' | 'resume';

/** 判断一个 unknown 是否为普通对象（不依赖 DOM 的 Object 判断） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 创建信令通道适配器。
 *
 * @param options 时钟 / 策略 / 可选 socket 工厂
 * @returns 符合 `SignalTransport` 契约的适配器实例
 */
export function createWsTransport(options: WsTransportOptions): SignalTransport {
  const clock = options.clock;
  const heartbeatCfg = options.policy.wsHeartbeat;
  const socketFactory = options.socketFactory ?? ((url: string): WebSocket => new WebSocket(url));

  let state: TransportState = 'idle';
  let socket: WebSocket | null = null;
  let handler: ((e: SignalEvent) => void) | null = null;

  /** 握手超时定时器 */
  let connectTimer: number | null = null;
  /** 心跳 tick 定时器 */
  let heartbeatTimer: number | null = null;
  /** 心跳状态（纯数据，判定逻辑复用 shared 的 evaluate） */
  let heartbeat: HeartbeatState = createHeartbeat(clock.now());
  /** 心跳是否已停（stopHeartbeat 后不再续期，避免定时器泄漏） */
  let heartbeatStopped = true;

  /** `closed` 事件是否已上报过（防止 close() 与 onclose 双报） */
  let closeEmitted = false;
  /** 主动关闭标记（用于 `closed.intentional`） */
  let intentionalClose = false;
  /** 最近一次**成功写入** socket 的消息类型（用于旧服务端探测归因） */
  let lastSentType: ClientSignalingMsg['t'] | null = null;

  /** 单播上报（无监听者时静默丢弃，不抛错） */
  function emit(e: SignalEvent): void {
    handler?.(e);
  }

  function clearConnectTimer(): void {
    if (connectTimer !== null) {
      clock.clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer !== null) {
      clock.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /** 停心跳（幂等）：清定时器 + 标记停止，之后不再续期 */
  function stopHeartbeat(): void {
    heartbeatStopped = true;
    clearHeartbeatTimer();
  }

  /** 续期下一次心跳 tick */
  function scheduleHeartbeat(): void {
    if (heartbeatStopped) return;
    clearHeartbeatTimer();
    heartbeatTimer = clock.setTimeout(onHeartbeatTick, heartbeatCfg.intervalMs);
  }

  /**
   * 一次心跳 tick：
   * - `due`   → 发探测（单飞：有在途探测时不重复发）
   * - `dead`  → 上报 `heartbeat-dead` 并停心跳
   * - 其余    → 什么都不做
   */
  function onHeartbeatTick(): void {
    heartbeatTimer = null;
    if (heartbeatStopped || state !== 'open') return;

    const now = clock.now();
    const result = evaluate(heartbeat, now, heartbeatCfg);
    heartbeat = result.state;

    if (result.verdict === 'dead') {
      stopHeartbeat();
      emit({ type: 'heartbeat-dead' });
      return;
    }

    if (result.verdict === 'due') {
      if (writeOut({ t: 'ping', ts: now })) {
        heartbeat = markSent(heartbeat, now);
      }
    }

    scheduleHeartbeat();
  }

  /** 启动心跳（open 时调用；每次连接都重置状态） */
  function startHeartbeat(): void {
    heartbeat = createHeartbeat(clock.now());
    heartbeatStopped = false;
    scheduleHeartbeat();
  }

  /** 真正写 socket；返回是否写入成功 */
  function writeOut(msg: ClientSignalingMsg): boolean {
    if (state !== 'open' || socket === null) return false;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      return false;
    }
    lastSentType = msg.t;
    return true;
  }

  /** 最近一次发出的消息是否是探测报文（ping / resume） */
  function probeSourceOf(): ProbeSource | null {
    if (lastSentType === 'ping') return 'ping';
    if (lastSentType === 'resume') return 'resume';
    return null;
  }

  /**
   * 处理一条原始报文。
   *
   * 非 JSON / 缺少字符串 `t` 的报文**静默忽略**：这类报文来自中间代理或旧版本，
   * 上报给业务层只会制造噪声。
   */
  function handleRaw(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.t !== 'string') return;

    const msg = parsed as unknown as ServerSignalingMsg;

    // `pong` 只用于心跳记账，不进入业务分发
    if (msg.t === 'pong') {
      heartbeat = markPong(heartbeat, clock.now());
      return;
    }

    // 旧服务端兼容探测：只有「刚刚发过 ping / resume」时，这条错误才归因为探测失败
    if (msg.t === 'error') {
      const probe = probeSourceOf();
      const text = typeof msg.message === 'string' ? msg.message : '';
      if (probe !== null && isUnsupportedMessageError(text)) {
        stopHeartbeat();
        emit({ type: 'probe-unsupported', probe });
        return;
      }
    }

    emit({ type: 'msg', msg });
  }

  /** socket 关闭的统一处理（网络断开 / 主动关闭共用） */
  function handleClose(code: number): void {
    clearConnectTimer();
    stopHeartbeat();
    socket = null;
    state = 'closed';
    if (closeEmitted) return;
    closeEmitted = true;
    emit({ type: 'closed', code, intentional: intentionalClose });
  }

  /** 静默丢弃当前 socket（换连接时用，不上报任何事件） */
  function detachSilently(): void {
    const ws = socket;
    socket = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* 已经处于 CLOSING/CLOSED 时 close() 可能抛错，无需处理 */
    }
  }

  function connect(url: string, timeoutMs: number): void {
    clearConnectTimer();
    stopHeartbeat();
    detachSilently();

    state = 'connecting';
    closeEmitted = false;
    intentionalClose = false;
    lastSentType = null;

    const ws = socketFactory(url);
    socket = ws;

    ws.onopen = (): void => {
      if (socket !== ws) return;
      clearConnectTimer();
      state = 'open';
      emit({ type: 'open' });
      startHeartbeat();
    };

    ws.onmessage = (ev: MessageEvent): void => {
      if (socket !== ws) return;
      handleRaw(ev.data);
    };

    ws.onclose = (ev: CloseEvent): void => {
      if (socket !== ws) return;
      handleClose(typeof ev.code === 'number' ? ev.code : 1006);
    };

    ws.onerror = (): void => {
      if (socket !== ws) return;
      emit({ type: 'error', detail: 'socket-error' });
    };

    connectTimer = clock.setTimeout(() => {
      connectTimer = null;
      if (state !== 'connecting') return;
      // 握手超时：先标记已上报，再关 socket，避免 onclose 再报一次 closed
      state = 'closed';
      closeEmitted = true;
      stopHeartbeat();
      emit({ type: 'connect-timeout' });
      detachSilently();
    }, Math.max(0, timeoutMs));
  }

  function close(code = 1000): void {
    clearConnectTimer();
    stopHeartbeat();
    intentionalClose = true;
    state = 'closed';

    const ws = socket;
    if (!closeEmitted) {
      closeEmitted = true;
      emit({ type: 'closed', code, intentional: true });
    }
    socket = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* 忽略：关闭失败不影响语义 */
      }
    }
  }

  return {
    connect,
    close,
    send: writeOut,
    onEvent(cb: (e: SignalEvent) => void): void {
      handler = cb;
    },
    get readyState(): 'idle' | 'connecting' | 'open' | 'closed' {
      return state;
    },
  };
}
