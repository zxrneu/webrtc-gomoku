/**
 * WebRTC P2P 点对点连接核心客户端（WebRTC Client）
 *
 * 【WebRTC 连接核心概念 —— 小白科普】：
 * 1. RTCPeerConnection（PC）：
 *    浏览器原生提供的点对点连接对象。它负责两台电脑/手机之间的 NAT 打洞、网络加密握手、数据通道协商。
 * 2. RTCDataChannel（DC）：
 *    建立在 PC 之上的低延迟、双向数据通道。一旦建立，我们就可以像发 WebSocket 消息一样在两台设备之间
 *    光速互发 JSON（落子、聊天、悔棋），【完全不经过任何服务器】！
 * 3. 为什么是“发起方 (Initiator)”与“应答方 (Answerer)”？
 *    - 发起方（通常是房主）：负责主动创建 DataChannel（`pc.createDataChannel('gomoku')`），并生成 Offer 名片；
 *    - 应答方（通常是客人）：等待对端的通道创建事件（`pc.ondatachannel`），并生成 Answer 回执名片。
 */

import type {
  GameMessage,
  ManualOfferPayload,
  ManualAnswerPayload,
  P2pEvent,
  TransportInfo,
} from '@webrtc-gomoku/shared';
import { pack, unpack } from '@webrtc-gomoku/shared';

import { DEFAULT_ICE_SERVERS } from './iceConfig';

/**
 * 底层诊断事件（**只上报事件名，绝不上报原始报文 / SDP / candidate**）
 *
 * 为什么不用 `console.warn/error`：AGENTS §5 规定脱敏与日志出口必须可替换，
 * 且浏览器控制台里的原始错误对象可能夹带 SDP 片段。
 */
export type ClientDiagnostic = { kind: 'dc-error' } | { kind: 'dc-parse-failed' };

/**
 * WebRTCClient 初始化选项接口
 */
export interface WebRTCClientOptions {
  /** 收到对方经由 DataChannel 发送的对局消息（落子、聊天、悔棋等） */
  onMessage: (msg: GameMessage) => void;
  /** DataChannel 成功打开，进入连通对局状态 */
  onConnected: () => void;
  /** 连接断开或失败时触发 */
  onDisconnected: () => void;
  /** 网络质量（RTT 延时、连接类型）定期更新回调 */
  onTransportUpdate?: (info: TransportInfo) => void;
  /** 任何底层网络状态变化时触发（用于刷新 UI 状态指示灯） */
  onStateChange?: () => void;
  /**
   * 底层诊断出口（v1.1 增量，替代原先的 `console.warn/error`）。
   * 只上报事件名，不含任何原始数据。
   */
  onDiagnostic?: (d: ClientDiagnostic) => void;
  /**
   * ICE 服务器配置（STUN / TURN）
   * 默认使用内置的国内高可用 STUN 列表，应用启动后会异步向 /config 拉取覆盖
   */
  iceServers?: RTCIceServer[];
}

export class WebRTCClient {
  /** 底层 WebRTC 对等连接对象 */
  public pc: RTCPeerConnection | null = null;
  /** 底层 P2P 双向数据通道 */
  public dc: RTCDataChannel | null = null;
  /** 尚未生效的待处理 ICE 候选队列（信令模式下防乱序） */
  public pendingIce: RTCIceCandidateInit[] = [];
  /** 定期获取网络状态（RTT、连接类型）的定时器 */
  private statsTimer: any = null;
  /** 当前生效的 ICE 服务器配置 */
  private iceServers: RTCIceServer[];
  /**
   * 底层事件通道（v1.1 增量）。
   *
   * 为什么不复用 `onConnected` / `onDisconnected`：
   * 那两个回调是 v1 的语义（`disconnected` 立即上报），已被现有界面与用例锁定，
   * **不允许改变**。重连编排器需要的是「原始状态 + 去抖后的事件」，
   * 因此新增一条独立通道，由 `connection/p2pTransport.ts` 消费。
   */
  private transportHandler: ((e: P2pEvent) => void) | null = null;

  constructor(private options: WebRTCClientOptions) {
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
  }

  /**
   * 注册底层事件通道（单播，后注册覆盖先注册，避免监听器泄漏）。
   *
   * @param cb 接收 `dc-open` / `dc-closed` / `pc-state` / `msg` 的回调
   */
  public onTransportEvent(cb: (e: P2pEvent) => void): void {
    this.transportHandler = cb;
  }

  /** 向上层发送一条底层事件（无监听者时静默丢弃） */
  private emitTransport(e: P2pEvent): void {
    this.transportHandler?.(e);
  }

  /**
   * 更新后续建连使用的 ICE 配置（供 App 动态拉取 `/config` 后调用）
   * @param iceServers 新的 STUN/TURN 服务器数组
   */
  public setIceServers(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers;
  }

  /**
   * 获取当前生效的 ICE 配置
   */
  public getIceServers(): RTCIceServer[] {
    return this.iceServers;
  }

  /**
   * 初始化并创建一个全新的 RTCPeerConnection 实例
   *
   * @param isInitiator true 表示发起方（房主），false 表示应答方（加入者）
   * @param iceServers 可选的自定义服务器配置
   * @returns 初始化的 RTCPeerConnection 对象
   */
  public initPeer(isInitiator: boolean, iceServers?: RTCIceServer[]): RTCPeerConnection {
    // 换房防御第一原则：先彻底销毁上一局的旧连接与残留事件监听！
    this.close();

    // 1. 创建原生对等连接
    const pc = new RTCPeerConnection({ iceServers: iceServers ?? this.iceServers });
    this.pc = pc;

    // 2. DataChannel 通道绑定策略
    if (isInitiator) {
      // 发起方：主动创建名为 'gomoku' 的有序可靠数据通道（ordered: true）
      const dc = pc.createDataChannel('gomoku', { ordered: true });
      this.bindDataChannel(dc);
    } else {
      // 应答方：静静监听对端创建的通道事件
      pc.ondatachannel = (e) => {
        this.bindDataChannel(e.channel);
      };
    }

    // 3. 监听整体网络连接状态变化
    pc.onconnectionstatechange = () => {
      this.options.onStateChange?.();
      // v1.1：把**原始状态**透出给重连适配器（去抖逻辑在适配器里，不在这里）
      this.emitTransport({ type: 'pc-state', state: pc.connectionState });
      // 成功直连：开启 3 秒一次的网络指标轮询
      if (pc.connectionState === 'connected') {
        this.startStatsPoll();
      } else if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        // 网络中断或失败：停止轮询，通知界面切回断开状态
        this.stopStatsPoll();
        this.options.onDisconnected();
      }
    };

    // 监听 ICE 穿透通道状态变化（checking -> connected -> completed）
    pc.oniceconnectionstatechange = () => {
      this.options.onStateChange?.();
    };

    // 监听信令协商状态变化（stable -> have-local-offer -> ...）
    pc.onsignalingstatechange = () => {
      this.options.onStateChange?.();
    };

    return pc;
  }

  /**
   * 应用对端发来的 offer（**能复用就复用**，v1.1 重连协商的唯一正确入口）
   *
   * 【这是本次改造最贵的坑，务必读完再改】
   * `initPeer()` 的第一行是 `this.close()` —— 它会把「正在恢复的 PC」直接销毁。
   * 若在重连流程里用 `initPeer(false)` 处理对端 offer，本端 PC 每次都被换新，
   * 上一轮 ICE restart 收集到的候选全部作废，表现为「ICE restart 永远失败」。
   *
   * 因此本方法只在**真正不能复用**时（没有 PC / PC 已 closed / 协商状态不是 stable）
   * 才新建应答方 PC；其余情况一律复用现有 PC。
   *
   * @param offer 远端 offer（只需 `sdp`）
   * @returns 实际承载本次协商的 PeerConnection
   */
  public async applyRemoteOffer(offer: RTCSessionDescriptionInit): Promise<RTCPeerConnection> {
    const current = this.pc;
    if (
      current !== null &&
      current.connectionState !== 'closed' &&
      current.signalingState === 'stable'
    ) {
      await current.setRemoteDescription({ type: 'offer', sdp: offer.sdp ?? '' });
      return current;
    }

    const pc = this.initPeer(false);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp ?? '' });
    return pc;
  }

  /**
   * 只做一次 ICE restart（复用现有 PC，ADR-2）
   *
   * 与 `initPeer()` 的本质区别：**不销毁 PC**，只重新收集候选并生成新 offer，
   * 因此对端可以沿用同一个 PC 完成 answer，恢复时延通常 < 1s。
   *
   * @returns 新的本地 offer 描述（调用方负责经信令转发）
   * @throws 没有 PC 时抛错（由编排器降级为全量重建）
   */
  public async restartIce(): Promise<RTCSessionDescriptionInit> {
    const pc = this.pc;
    if (!pc) throw new Error('PeerConnection 未创建，无法执行 ICE restart');
    pc.restartIce();
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    return offer;
  }

  /**
   * 绑定 DataChannel 的收发事件监听
   * @param dc 目标 RTCDataChannel
   */
  private bindDataChannel(dc: RTCDataChannel) {
    this.dc = dc;

    // 通道就绪：通知上层应用连通成功，可以开始落子下棋
    dc.onopen = () => {
      this.options.onStateChange?.();
      this.options.onConnected();
      this.emitTransport({ type: 'dc-open' });
    };

    // 通道关闭
    dc.onclose = () => {
      this.options.onStateChange?.();
      this.options.onDisconnected();
      this.emitTransport({ type: 'dc-closed' });
    };

    // 异常监控（只上报事件名，原始错误对象可能夹带 SDP，禁止外泄）
    dc.onerror = () => {
      this.options.onDiagnostic?.({ kind: 'dc-error' });
      this.options.onStateChange?.();
    };

    // 核心：接收对端发来的数据包
    dc.onmessage = (e) => {
      const raw: unknown = e.data;
      let msg: GameMessage;
      try {
        const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : '');
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          typeof (parsed as { t?: unknown }).t !== 'string'
        ) {
          throw new Error('局内消息缺少字符串类型字段 t');
        }
        msg = parsed as GameMessage;
      } catch {
        this.options.onDiagnostic?.({ kind: 'dc-parse-failed' });
        return;
      }
      this.options.onMessage(msg);
      this.emitTransport({ type: 'msg', msg });
    };
  }

  /**
   * 通过 P2P DataChannel 向对方发送一条对局消息（落子、聊天、悔棋等）
   * @param msg 消息对象
   * @returns true 表示发送成功，false 表示通道未准备好
   */
  public sendMessage(msg: GameMessage): boolean {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * 等待所有 ICE 候选地址收集完毕（ICE Gathering Complete）
   *
   * 【手动邀请码模式的关键设计】：
   * 在信令服务器模式下，ICE 候选是一个个实时通过 WebSocket 转发的（Trickle ICE）；
   * 但在“无服务器微信扫码模式”下，我们不能发无数次二维码！
   * 必须等待浏览器把所有内网和公网候选全部收集打包并写入当前 SDP 中（Vanilla ICE），
   * 这样只需要生成【唯一一个包含完整地址的二维码】即可一次性成功连通！
   *
   * @param pc 当前对等连接
   * @param timeout 超时毫秒数（默认 4 秒，防止某些网卡收集过慢卡死）
   */
  public async waitIce(pc: RTCPeerConnection, timeout = 4000): Promise<void> {
    if (pc.iceGatheringState === 'complete') return;
    return new Promise((resolve) => {
      let timer: any = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      timer = setTimeout(done, timeout);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // ==========================================
  // 手动信令流程（零服务器模式：生成/解析邀请码）
  // ==========================================

  /**
   * 房主发起：创建 Offer 邀请码
   *
   * 步骤：
   * 1. 初始化发起方 PeerConnection 与 DataChannel
   * 2. 调用 pc.createOffer() 生成本地会话描述
   * 3. pc.setLocalDescription(offer) 设置为本地描述
   * 4. 等待 ICE 候选收集完毕，全部嵌入 SDP
   * 5. 将完整的 SDP 结构通过 pack() 压缩成一个短字符串并返回
   *
   * @param name 房主昵称
   * @returns 经过 deflate + base64url 压缩后的短邀请码（以 'Z' 开头）
   */
  public async createHostOffer(name: string): Promise<string> {
    const pc = this.initPeer(true, this.iceServers);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitIce(pc); // 等待候选全部打入本地 SDP

    const payload: ManualOfferPayload = {
      type: 'offer',
      sdp: pc.localDescription?.sdp || offer.sdp || '',
      name,
    };
    return pack(payload);
  }

  /**
   * 加入方应答：解析房主邀请码，并生成 Answer 应答码
   *
   * 步骤：
   * 1. unpack 解压缩房主的 Offer 邀请码
   * 2. 创建接收方 PeerConnection
   * 3. setRemoteDescription 将房主 SDP 设为远端描述
   * 4. createAnswer() 生成应答描述并 setLocalDescription
   * 5. 等待自己的 ICE 候选收集完毕
   * 6. 打包压缩生成 Answer 应答码
   *
   * @param offerCode 房主出示的邀请码
   * @param name 加入方昵称
   * @returns 压缩后的 Answer 应答码（以 'Z' 开头）
   */
  public async handleGuestOffer(offerCode: string, name: string): Promise<string> {
    const payload = await unpack<ManualOfferPayload>(offerCode);
    if (!payload || payload.type !== 'offer' || !payload.sdp) {
      throw new Error('无效的邀请码，请确认复制完整');
    }

    const pc = this.initPeer(false, this.iceServers);
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: payload.sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitIce(pc);

    const ansPayload: ManualAnswerPayload = {
      type: 'answer',
      sdp: pc.localDescription?.sdp || answer.sdp || '',
      name,
    };
    return pack(ansPayload);
  }

  /**
   * 房主收尾：输入加入方的 Answer 应答码，完成 WebRTC 最终握手
   *
   * @param answerCode 加入方出示的应答码
   * @returns 解析后的应答数据对象
   */
  public async finishHostConnection(answerCode: string): Promise<ManualAnswerPayload> {
    if (!this.pc) throw new Error('PeerConnection 未创建');
    const payload = await unpack<ManualAnswerPayload>(answerCode);
    if (!payload || payload.type !== 'answer' || !payload.sdp) {
      throw new Error('无效的应答码，请确认复制完整');
    }
    // 将对方的 Answer 设为远端描述，底层通道立刻开始连通！
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }));
    return payload;
  }

  // ==========================================
  // 网络质量统计与链路探测 (getStats)
  // ==========================================

  /**
   * 读取当前直连链路的真实状态指标（RTT 延迟、网络类型、IP 版本）
   * @returns 格式化后的 TransportInfo 对象；若未连通则返回 null
   */
  public async getTransportInfo(): Promise<TransportInfo | null> {
    if (!this.pc) return null;
    try {
      const stats = await this.pc.getStats();
      let selectedPairId: string | null = null;
      
      // 1. 查找当前真正承载流量的 candidate-pair（候选对）
      for (const report of stats.values()) {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
          break;
        }
      }

      let pairReport: any = null;
      if (selectedPairId && stats.has(selectedPairId)) {
        pairReport = stats.get(selectedPairId);
      } else {
        // 兼容模式：部分旧浏览器通过 selected / nominated 标记
        for (const report of stats.values()) {
          if (report.type === 'candidate-pair' && (report.selected || report.nominated)) {
            pairReport = report;
            break;
          }
        }
      }

      if (!pairReport) return null;

      // 2. 提取本地候选信息与往返延时 RTT
      const local = stats.get(pairReport.localCandidateId);
      const rtt = pairReport.currentRoundTripTime
        ? Math.round(pairReport.currentRoundTripTime * 1000)
        : undefined;

      // 3. 判定候选类型：host / srflx / prflx / relay
      const candidateType = local?.candidateType || 'p2p';
      const ip = local?.ip || local?.address || '';
      const ipVersion = ip.includes(':') ? 'IPv6' : ip ? 'IPv4' : undefined;

      const typeLabels: Record<string, string> = {
        host: '局域网/本机直连',
        srflx: '公网 P2P 直连',
        prflx: '对等直连',
        relay: 'TURN 中继',
      };

      const summary = `${typeLabels[candidateType] || candidateType} ${ipVersion ? `(${ipVersion})` : ''} ${rtt !== undefined ? `· ${rtt}ms` : ''}`;

      return { candidateType, ipVersion, rtt, summary };
    } catch {
      return null;
    }
  }

  /**
   * 启动每 3 秒一次的网络链路状态轮询
   */
  private startStatsPoll() {
    this.stopStatsPoll();
    const poll = async () => {
      const info = await this.getTransportInfo();
      if (info && this.options.onTransportUpdate) {
        this.options.onTransportUpdate(info);
      }
    };
    poll();
    this.statsTimer = setInterval(poll, 3000);
  }

  /**
   * 停止网络链路轮询
   */
  private stopStatsPoll() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /**
   * 主动断开并释放当前连接（换房 / 组件卸载时调用）
   *
   * 【避坑高精尖设计：解绑防串台机制】：
   * 关键细节：必须「先将所有的事件监听函数置为 null，然后再调用 close()」！
   * 为什么？
   * 因为调用 `pc.close()` 或 `dc.close()` 本身会触发异步的 `onclose` 和 `onconnectionstatechange` 事件。
   * 如果用户切换了新房间，旧连接迟到的断开事件就会误伤新房间，把新房间刚连上的状态又置为断开！
   * 先把监听器置空，彻底杜绝了事件串台可能。
   */
  public close() {
    this.stopStatsPoll();

    const dc = this.dc;
    const pc = this.pc;
    this.dc = null;
    this.pc = null;
    this.pendingIce = [];

    // 1. 先解绑 DataChannel 所有处理器，再 close
    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onerror = null;
      dc.onmessage = null;
      try { dc.close(); } catch {}
    }
    // 2. 先解绑 PeerConnection 所有处理器，再 close
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onsignalingstatechange = null;
      pc.ondatachannel = null;
      pc.onicecandidate = null;
      try { pc.close(); } catch {}
    }
  }
}

