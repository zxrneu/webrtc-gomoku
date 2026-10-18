/**
 * ============================================================================
 * P2P 通道适配器（`P2pTransport` 的浏览器实现）
 * ============================================================================
 * 职责：把 `WebRTCClient` 的「事件回调 + 异步协商方法」翻译成编排器认识的
 * **纯事件流**（`P2pEvent`），并承担三件 `shared` 不允许做的事：
 *
 * ① **`disconnected` 去抖（M3 误报基线，最关键的坑）**
 *    `pc.connectionState === 'disconnected'` 在真实网络里会因 WiFi 抖动、切网、
 *    短暂丢包频繁出现，而且**常常自己恢复**。若像 v1 那样一出现就报断开，
 *    用户会看到「网络波动」提示疯狂闪 —— 直接违反 PRD M3「3s 抖动零提示」。
 *    因此本适配器只在 `disconnected` **持续 ≥ disconnectedGraceMs(5s)** 时才上报
 *    `pc-disconnected-settled`；`failed` 属于终态，立即上报，不去抖。
 *
 * ② **ICE restart 复用 PC（ADR-2）**
 *    `restartIce()` 必须走 `pc.restartIce()` + `createOffer({iceRestart:true})`，
 *    **绝不允许**调用 `initPeer()`（它首行是 `this.close()`，会把正在恢复的 PC 销毁，
 *    表现为「ICE restart 永远失败」）。全量重建才允许 `initPeer()`，且必须带
 *    `rebuild: true` 标记，让对端知道要丢掉旧 PC。
 *
 * ③ **DC 应用层心跳 + 旧对端识别**
 *    PC 有时会「假活」：`connectionState` 还是 `connected`，但数据通道早已收不到东西。
 *    因此 DC 上每 5s 发一次 `{t:'ping'}`，3s 无 `pong` 记 miss，连续 2 次判死。
 *    **但**：v1 客户端不认识 `ping`，永远不会回 `pong`。若机械判死，新客户端连旧客户端
 *    就会无限误判。判定规则：**从未收到过 pong** 且 `pc=connected` 且 `dc=open`
 *    → 认定对端是 v1，关闭 DC 心跳（不再误报），恢复依赖 PC 状态 + WS 心跳。
 */

import type {
  Clock,
  GameMessage,
  HeartbeatState,
  PcConnectionState,
  P2pEvent,
  P2pTransport,
  ReconnectPolicy,
} from '@webrtc-gomoku/shared';
import { createHeartbeat, evaluate, markPong, markSent } from '@webrtc-gomoku/shared';

import type { WebRTCClient } from '../webrtc';

/** 信令线上格式（与 v1 `{kind:'offer'|'answer'|'ice'}` 完全兼容，只新增可选 `rebuild`） */
export interface SignalPayload {
  kind: 'offer' | 'answer' | 'ice';
  /** offer/answer 的 SDP；兼容 v1 的 `RTCSessionDescription` 对象与纯字符串 */
  sdp?: unknown;
  /** ICE 候选（v1 的 `candidate.toJSON()` 结果） */
  candidate?: unknown;
  /** 房主全量重建标记：对端收到后必须丢弃旧 PC */
  rebuild?: boolean;
  /** 是否为 ICE restart 生成的 offer（仅用于对端诊断，不影响协商流程） */
  iceRestart?: boolean;
}

/** 适配器可注入的构造参数 */
export interface P2pTransportOptions {
  /** 注入时钟 */
  clock: Clock;
  /** 策略参数（去抖窗口 / DC 心跳参数都从这里读，禁止写字面量） */
  policy: ReconnectPolicy;
  /** 底层 WebRTC 客户端（由 `useConnection` 创建并注入 ICE 配置） */
  client: WebRTCClient;
  /** 需要经信令服务器转发的 offer / answer / ice */
  signalOut: (data: unknown) => void;
}

/** 判断一个 unknown 是否为普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 把线上 `sdp` 字段归一化成字符串（兼容 `{type,sdp}` 与纯字符串） */
function sdpOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.sdp === 'string') return value.sdp;
  return '';
}

/** 判断是否为本适配器认识的信号载荷 */
function isSignalPayload(data: unknown): data is SignalPayload {
  if (!isRecord(data)) return false;
  return data.kind === 'offer' || data.kind === 'answer' || data.kind === 'ice';
}

/**
 * 创建 P2P 通道适配器。
 *
 * @param options 时钟 / 策略 / WebRTC 客户端 / 信令外发回调
 * @returns 符合 `P2pTransport` 契约的适配器实例
 */
export function createP2pTransport(options: P2pTransportOptions): P2pTransport {
  const clock = options.clock;
  const p2pCfg = options.policy.p2p;
  const dcHeartbeatCfg = p2pCfg.dcHeartbeat;
  const client = options.client;

  let handler: ((e: P2pEvent) => void) | null = null;
  /**
   * 静音开关（防串台）。
   *
   * **注意**：这不是「销毁」标志。编排器在 `startSession` 里会先调 `p2p.close()`
   * 清掉上一局的 PC，随后再 `attach()` 建新连接；如果这里做成一次性销毁标志，
   * 后续 `attach/sendOffer` 会被永久静音 —— 表现就是「房主建了 PC 却永远不发 offer」。
   * 因此 `close()` 只静音 + 拆连接，`attach/rebuild/applyRemoteSignal` 会重新解除静音。
   */
  let muted = false;
  /**
   * 协商代次。每次新建/重建 PC 递增。
   * 异步协商（createOffer/setLocalDescription）跨 await 后必须校验代次，
   * 否则「旧 PC 迟到的 offer」会污染刚重建的新连接。
   */
  let generation = 0;

  /** `disconnected` 去抖定时器 */
  let graceTimer: number | null = null;

  /** DC 心跳 tick 定时器 */
  let heartbeatTimer: number | null = null;
  /** DC 心跳状态 */
  let heartbeat: HeartbeatState = createHeartbeat(clock.now());
  /** DC 心跳是否已停 */
  let heartbeatStopped = true;
  /** 本次 DC 生命周期内是否收到过 pong（用于识别 v1 对端） */
  let everPonged = false;

  function emit(e: P2pEvent): void {
    if (muted) return;
    handler?.(e);
  }

  // ---------------------------------------------------------------- 去抖

  function clearGrace(): void {
    if (graceTimer !== null) {
      clock.clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function armGrace(): void {
    if (graceTimer !== null) return;
    graceTimer = clock.setTimeout(() => {
      graceTimer = null;
      emit({ type: 'pc-disconnected-settled' });
    }, p2pCfg.disconnectedGraceMs);
  }

  /** PC 状态变化：`failed` 立即报，`disconnected` 去抖，`connected` 取消去抖 */
  function onPcState(state: PcConnectionState): void {
    emit({ type: 'pc-state', state });

    if (state === 'failed') {
      clearGrace();
      emit({ type: 'pc-failed' });
      return;
    }
    if (state === 'disconnected') {
      armGrace();
      return;
    }
    if (state === 'connected') {
      clearGrace();
    }
  }

  // ------------------------------------------------------------ DC 心跳

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer !== null) {
      clock.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function stopDcHeartbeat(): void {
    heartbeatStopped = true;
    clearHeartbeatTimer();
  }

  function scheduleDcHeartbeat(): void {
    if (heartbeatStopped) return;
    clearHeartbeatTimer();
    heartbeatTimer = clock.setTimeout(onDcHeartbeatTick, dcHeartbeatCfg.intervalMs);
  }

  /** PC 是否仍自称连通（v1 对端识别的必要条件之一） */
  function isPcConnected(): boolean {
    return client.pc?.connectionState === 'connected';
  }

  /** DC 是否 open（v1 对端识别的必要条件之一） */
  function isDcOpen(): boolean {
    return client.dc !== null && client.dc.readyState === 'open';
  }

  function onDcHeartbeatTick(): void {
    heartbeatTimer = null;
    if (heartbeatStopped || muted) return;

    const now = clock.now();
    const result = evaluate(heartbeat, now, dcHeartbeatCfg);
    heartbeat = result.state;

    if (result.verdict === 'dead') {
      // 从未收到 pong，但 PC 与 DC 都还「自称健康」→ 对端是 v1，不误报
      if (!everPonged && isPcConnected() && isDcOpen()) {
        stopDcHeartbeat();
        return;
      }
      stopDcHeartbeat();
      emit({ type: 'pc-disconnected-settled' });
      return;
    }

    if (result.verdict === 'due') {
      if (client.sendMessage({ t: 'ping', ts: now })) {
        heartbeat = markSent(heartbeat, now);
      }
    }

    scheduleDcHeartbeat();
  }

  function startDcHeartbeat(): void {
    heartbeat = createHeartbeat(clock.now());
    everPonged = false;
    heartbeatStopped = false;
    scheduleDcHeartbeat();
  }

  // ------------------------------------------------------------ 消息分发

  /** DC 收到的局内消息：ping/pong 属于控制消息，不进业务层 */
  function handleDcMessage(msg: GameMessage): void {
    if (msg.t === 'pong') {
      everPonged = true;
      heartbeat = markPong(heartbeat, clock.now());
      return;
    }
    if (msg.t === 'ping') {
      client.sendMessage({ t: 'pong', ts: msg.ts });
      return;
    }
    emit({ type: 'msg', msg });
  }

  // ------------------------------------------------------------ 协商动作

  /** 把本地 ICE 候选外发（Trickle ICE，与 v1 线上格式一致） */
  function wireIceOut(pc: RTCPeerConnection, gen: number): void {
    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent): void => {
      if (muted || gen !== generation) return;
      if (!ev.candidate) return;
      const candidate =
        typeof ev.candidate.toJSON === 'function' ? ev.candidate.toJSON() : ev.candidate;
      options.signalOut({ kind: 'ice', candidate } satisfies SignalPayload);
    };
  }

  /** 房主：生成并外发 offer；`rebuild` 为 true 时带上重建标记 */
  async function sendOffer(gen: number, rebuild: boolean): Promise<void> {
    try {
      const pc = client.pc;
      if (!pc) return;
      const offer = await pc.createOffer();
      if (muted || gen !== generation) return;
      await pc.setLocalDescription(offer);
      if (muted || gen !== generation) return;
      const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
      const payload: SignalPayload = rebuild
        ? { kind: 'offer', sdp, rebuild: true }
        : { kind: 'offer', sdp };
      options.signalOut(payload);
    } catch {
      /* 具体失败由编排器的步骤超时兜底，避免未捕获 rejection */
    }
  }

  /** 应用远端 offer 并回 answer（复用 PC 的能力由 `WebRTCClient.applyRemoteOffer` 保证） */
  async function answerOffer(gen: number, sdp: string): Promise<void> {
    try {
      const pc = await client.applyRemoteOffer({ type: 'offer', sdp });
      if (muted || gen !== generation) return;
      wireIceOut(pc, gen);

      await flushPendingIce(pc);
      if (muted || gen !== generation) return;

      const answer = await pc.createAnswer();
      if (muted || gen !== generation) return;

      await pc.setLocalDescription(answer);
      if (muted || gen !== generation) return;

      const out = pc.localDescription?.sdp ?? answer.sdp ?? '';
      options.signalOut({ kind: 'answer', sdp: out } satisfies SignalPayload);
    } catch {
      /* 协商失败由编排器的步骤超时兜底（`onP2pLost('ICE_FAILED')`），此处只吞掉 rejection */
    }
  }

  /** 把「远端描述尚未就绪时缓存下来的候选」补灌进 PC */
  async function flushPendingIce(pc: RTCPeerConnection): Promise<void> {
    const pending = client.pendingIce;
    client.pendingIce = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* 单个候选失败不影响整体连通，丢弃即可 */
      }
    }
  }

  /** 应用远端 answer */
  async function applyAnswer(sdp: string): Promise<void> {
    const pc = client.pc;
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    await flushPendingIce(pc);
  }

  /** 应用远端 ICE 候选（远端描述未就绪时先缓存） */
  async function applyIce(candidate: unknown): Promise<void> {
    const pc = client.pc;
    if (!pc || !pc.remoteDescription) {
      client.pendingIce.push(candidate as RTCIceCandidateInit);
      return;
    }
    try {
      await pc.addIceCandidate(candidate as RTCIceCandidateInit);
    } catch {
      client.pendingIce.push(candidate as RTCIceCandidateInit);
    }
  }

  // ------------------------------------------------------------ 公共动作

  function attach(isInitiator: boolean): void {
    muted = false;
    clearGrace();
    stopDcHeartbeat();
    const gen = ++generation;
    const pc = client.initPeer(isInitiator);
    wireIceOut(pc, gen);
    if (isInitiator) {
      // 房主恒为 offerer（ADR-1）；加入方只等待 offer，结构性消除 glare
      void sendOffer(gen, false);
    }
  }

  async function restartIce(): Promise<void> {
    // 关键：复用现有 PC，绝不 initPeer（否则正在恢复的 PC 被销毁）
    const gen = generation;
    const offer = await client.restartIce();
    if (muted || gen !== generation) return;
    const payload: SignalPayload = { kind: 'offer', sdp: offer.sdp ?? '', iceRestart: true };
    options.signalOut(payload);
  }

  async function rebuild(isInitiator: boolean): Promise<void> {
    muted = false;
    clearGrace();
    stopDcHeartbeat();
    const gen = ++generation;
    const pc = client.initPeer(isInitiator);
    wireIceOut(pc, gen);
    if (isInitiator) {
      await sendOffer(gen, true);
    }
  }

  async function applyRemoteSignal(data: unknown): Promise<void> {
    // 关键：远端信令到达本身就是「本端需要参与协商」的证据，必须解除静音。
    // 编排器 `startSession()` 会先 `p2p.close()` 清场，而加入方从不调用 `attach()`
    // （只等待 offer），若这里被静音拦住，加入方会永远不建 PC、不回 answer。
    muted = false;
    if (!isSignalPayload(data)) return;

    if (data.kind === 'offer') {
      const sdp = sdpOf(data.sdp);
      if (!sdp) return;
      if (data.rebuild === true) {
        // 对端已全量重建：本端必须丢弃旧 PC（否则永远协商不上）
        const gen = ++generation;
        const pc = client.initPeer(false);
        wireIceOut(pc, gen);
        await answerOffer(gen, sdp);
        return;
      }
      await answerOffer(generation, sdp);
      return;
    }

    if (data.kind === 'answer') {
      const sdp = sdpOf(data.sdp);
      if (!sdp) return;
      await applyAnswer(sdp);
      return;
    }

    await applyIce(data.candidate);
  }

  function send(msg: GameMessage): boolean {
    return client.sendMessage(msg);
  }

  function close(): void {
    muted = true;
    generation += 1;
    clearGrace();
    stopDcHeartbeat();
    client.close();
  }

  // WebRTCClient 的底层事件通道（v1.1 新增，不改变 v1 回调语义）
  client.onTransportEvent((e: P2pEvent): void => {
    if (muted) return;
    switch (e.type) {
      case 'dc-open':
        emit({ type: 'dc-open' });
        startDcHeartbeat();
        break;
      case 'dc-closed':
        stopDcHeartbeat();
        emit({ type: 'dc-closed' });
        break;
      case 'msg':
        handleDcMessage(e.msg);
        break;
      case 'pc-state':
        onPcState(e.state);
        break;
      default:
        // signal-out / ice-restart-failed 等由 WebRTCClient 之外的层负责，这里不再二次分发
        break;
    }
  });

  return {
    attach,
    restartIce,
    rebuild,
    applyRemoteSignal,
    send,
    isDcOpen,
    onEvent(cb: (e: P2pEvent) => void): void {
      handler = cb;
    },
    close,
  };
}
