import type {
  GameMessage,
  ManualOfferPayload,
  ManualAnswerPayload,
  TransportInfo,
} from '@webrtc-gomoku/shared';
import { pack, unpack } from '@webrtc-gomoku/shared';

import { DEFAULT_ICE_SERVERS } from './iceConfig';

export interface WebRTCClientOptions {
  onMessage: (msg: GameMessage) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onTransportUpdate?: (info: TransportInfo) => void;
  onStateChange?: () => void;
  /**
   * ICE 配置（STUN/TURN）。默认 {@link DEFAULT_ICE_SERVERS}，保证永不未初始化；
   * 由 App 在挂载后经 `GET /config` 动态覆盖。
   */
  iceServers?: RTCIceServer[];
}

export class WebRTCClient {
  public pc: RTCPeerConnection | null = null;
  public dc: RTCDataChannel | null = null;
  public pendingIce: RTCIceCandidateInit[] = [];
  private statsTimer: any = null;
  private iceServers: RTCIceServer[];

  constructor(private options: WebRTCClientOptions) {
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
  }

  /** 更新后续建连使用的 ICE 配置（供动态拉取 `/config` 后调用）。 */
  public setIceServers(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers;
  }

  /** 读取当前生效的 ICE 配置。 */
  public getIceServers(): RTCIceServer[] {
    return this.iceServers;
  }

  public initPeer(isInitiator: boolean, iceServers?: RTCIceServer[]): RTCPeerConnection {
    this.close();

    const pc = new RTCPeerConnection({ iceServers: iceServers ?? this.iceServers });
    this.pc = pc;

    if (isInitiator) {
      const dc = pc.createDataChannel('gomoku', { ordered: true });
      this.bindDataChannel(dc);
    } else {
      pc.ondatachannel = (e) => {
        this.bindDataChannel(e.channel);
      };
    }

    pc.onconnectionstatechange = () => {
      this.options.onStateChange?.();
      if (pc.connectionState === 'connected') {
        this.startStatsPoll();
      } else if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        this.stopStatsPoll();
        this.options.onDisconnected();
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.options.onStateChange?.();
    };

    pc.onsignalingstatechange = () => {
      this.options.onStateChange?.();
    };

    return pc;
  }

  private bindDataChannel(dc: RTCDataChannel) {
    this.dc = dc;
    dc.onopen = () => {
      this.options.onStateChange?.();
      this.options.onConnected();
    };
    dc.onclose = () => {
      this.options.onStateChange?.();
      this.options.onDisconnected();
    };
    dc.onerror = (e) => {
      console.warn('DataChannel error:', e);
      this.options.onStateChange?.();
    };
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as GameMessage;
        this.options.onMessage(msg);
      } catch (err) {
        console.error('Failed to parse game message:', err);
      }
    };
  }

  public sendMessage(msg: GameMessage): boolean {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

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

  /* ---------------- 手动信令流程 ---------------- */

  public async createHostOffer(name: string): Promise<string> {
    const pc = this.initPeer(true, this.iceServers);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitIce(pc);

    const payload: ManualOfferPayload = {
      type: 'offer',
      sdp: pc.localDescription?.sdp || offer.sdp || '',
      name,
    };
    return pack(payload);
  }

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

  public async finishHostConnection(answerCode: string): Promise<ManualAnswerPayload> {
    if (!this.pc) throw new Error('PeerConnection 未创建');
    const payload = await unpack<ManualAnswerPayload>(answerCode);
    if (!payload || payload.type !== 'answer' || !payload.sdp) {
      throw new Error('无效的应答码，请确认复制完整');
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }));
    return payload;
  }

  /* ---------------- 统计与链路信息 ---------------- */

  public async getTransportInfo(): Promise<TransportInfo | null> {
    if (!this.pc) return null;
    try {
      const stats = await this.pc.getStats();
      let selectedPairId: string | null = null;
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
        for (const report of stats.values()) {
          if (report.type === 'candidate-pair' && (report.selected || report.nominated)) {
            pairReport = report;
            break;
          }
        }
      }

      if (!pairReport) return null;

      const local = stats.get(pairReport.localCandidateId);
      const rtt = pairReport.currentRoundTripTime
        ? Math.round(pairReport.currentRoundTripTime * 1000)
        : undefined;

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

  private stopStatsPoll() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /**
   * 主动断开并释放当前连接（换房 / 组件卸载）。
   *
   * 关键：先摘掉全部事件处理器再关闭——`close()` 自身触发的 `onclose`、
   * `connectionstatechange` 等迟到事件绝不能再回调 `onDisconnected`，
   * 否则「上一房间」的断线事件会把新房间刚建立的连接状态清空。
   */
  public close() {
    this.stopStatsPoll();

    const dc = this.dc;
    const pc = this.pc;
    this.dc = null;
    this.pc = null;
    this.pendingIce = [];

    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onerror = null;
      dc.onmessage = null;
      try { dc.close(); } catch {}
    }
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
