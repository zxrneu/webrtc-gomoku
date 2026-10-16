import type {
  GameMessage,
  ManualOfferPayload,
  ManualAnswerPayload,
  TransportInfo,
} from '@webrtc-gomoku/shared';
import { pack, unpack } from '@webrtc-gomoku/shared';

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.qq.com:3478', 'stun:stun.aliyun.com:3478'] },
  { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
];

export interface WebRTCClientOptions {
  onMessage: (msg: GameMessage) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onTransportUpdate?: (info: TransportInfo) => void;
  onStateChange?: () => void;
}

export class WebRTCClient {
  public pc: RTCPeerConnection | null = null;
  public dc: RTCDataChannel | null = null;
  public pendingIce: RTCIceCandidateInit[] = [];
  private statsTimer: any = null;

  constructor(private options: WebRTCClientOptions) {}

  public initPeer(isInitiator: boolean): RTCPeerConnection {
    this.close();

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
    const pc = this.initPeer(true);
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

    const pc = this.initPeer(false);
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

  public close() {
    this.stopStatsPoll();
    if (this.dc) {
      try { this.dc.close(); } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this.pendingIce = [];
  }
}
