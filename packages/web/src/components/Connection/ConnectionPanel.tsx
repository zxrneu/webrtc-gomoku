import React, { useRef, useEffect } from 'react';
import type { FlowState, ScannerTarget } from '../../types';
import { renderQrToCanvas } from '../../qr';
import styles from './ConnectionPanel.module.css';

interface ConnectionPanelProps {
  name: string;
  setName: (name: string) => void;
  activeTab: 'room' | 'manual';
  setActiveTab: (tab: 'room' | 'manual') => void;
  flow: FlowState;
  roomCode: string;
  inputRoomCode: string;
  setInputRoomCode: (code: string) => void;
  roomStatus: string;
  hostOfferCode: string;
  guestOfferInput: string;
  setGuestOfferInput: (code: string) => void;
  hostAnswerInput: string;
  setHostAnswerInput: (code: string) => void;
  guestAnswerCode: string;
  hostTimer: string;
  hostTextFolded: boolean;
  setHostTextFolded: (fn: (prev: boolean) => boolean) => void;
  guestTextFolded: boolean;
  setGuestTextFolded: (fn: (prev: boolean) => boolean) => void;
  onCreateRoom: () => void;
  onJoinRoom: () => void;
  onCopyInviteLink: () => void;
  onStartHostFlow: () => void;
  onStartGuestFlow: () => void;
  onCopyHostOffer: () => void;
  onCopyGuestAnswer: () => void;
  onGuestGenerateAnswer: () => void;
  onHostFinish: () => void;
  onOpenScanner: (target: ScannerTarget) => void;
  flowResult: { type: string; html: string } | null;
}

export const ConnectionPanel: React.FC<ConnectionPanelProps> = ({
  name,
  setName,
  activeTab,
  setActiveTab,
  flow,
  roomCode,
  inputRoomCode,
  setInputRoomCode,
  roomStatus,
  hostOfferCode,
  guestOfferInput,
  setGuestOfferInput,
  hostAnswerInput,
  setHostAnswerInput,
  guestAnswerCode,
  hostTimer,
  hostTextFolded,
  setHostTextFolded,
  guestTextFolded,
  setGuestTextFolded,
  onCreateRoom,
  onJoinRoom,
  onCopyInviteLink,
  onStartHostFlow,
  onStartGuestFlow,
  onCopyHostOffer,
  onCopyGuestAnswer,
  onGuestGenerateAnswer,
  onHostFinish,
  onOpenScanner,
  flowResult,
}) => {
  const isFileProtocol =
    typeof window !== 'undefined' && window.location.protocol === 'file:';

  const hostQrRef = useRef<HTMLCanvasElement | null>(null);
  const guestQrRef = useRef<HTMLCanvasElement | null>(null);

  // 渲染邀请方 QR 码
  useEffect(() => {
    if (hostOfferCode && hostQrRef.current) {
      renderQrToCanvas(hostQrRef.current, hostOfferCode);
    }
  }, [hostOfferCode, flow]);

  // 渲染被邀请方 QR 码
  useEffect(() => {
    if (guestAnswerCode && guestQrRef.current) {
      renderQrToCanvas(guestQrRef.current, guestAnswerCode);
    }
  }, [guestAnswerCode, flow]);

  const fstepNumber =
    flow === 'connected'
      ? 3
      : flow === 'guest-wait'
      ? 2
      : flow === 'host-wait' || flow === 'guest-invite'
      ? 1
      : 0;

  const toggleHostText = () => {
    const out = document.getElementById('flow-host-out');
    const btn = document.getElementById('flow-host-toggle-text');
    const isCurrentlyFolded = out ? out.classList.contains('is-folded') : hostTextFolded;
    const next = !isCurrentlyFolded;
    if (out) out.classList.toggle('is-folded', next);
    if (btn) btn.textContent = next ? '查看文本码' : '收起文本码';
    setHostTextFolded(() => next);
  };

  const toggleGuestText = () => {
    const out = document.getElementById('flow-guest-out');
    const btn = document.getElementById('flow-guest-toggle-text');
    const isCurrentlyFolded = out ? out.classList.contains('is-folded') : guestTextFolded;
    const next = !isCurrentlyFolded;
    if (out) out.classList.toggle('is-folded', next);
    if (btn) btn.textContent = next ? '查看文本码' : '收起文本码';
    setGuestTextFolded(() => next);
  };

  return (
    <div id="connect-card" className={`${styles.connectCard} card`}>
      <label className={`${styles.nameField} field name-field`}>
        <span>昵称（对方可见）</span>
        <input
          id="name-input"
          type="text"
          maxLength={12}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="输入昵称后才能创建 / 加入房间"
          autoComplete="off"
          className={styles.nameInput}
        />
      </label>

      <div className={`${styles.tabs} tabs`}>
        <button
          className={`${styles.tab} ${activeTab === 'room' ? `${styles.active} active` : ''} tab`}
          data-tab="room"
          onClick={() => setActiveTab('room')}
        >
          房间联机
          <em className={`${styles.tabNote} tab-note`}>需服务器 · 规划中</em>
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'manual' ? `${styles.active} active` : ''} tab`}
          data-tab="manual"
          onClick={() => setActiveTab('manual')}
        >
          邀请对局
        </button>
      </div>

      {/* 房间联机面板 */}
      <div
        id="tab-room"
        className={`tab-panel ${activeTab === 'room' ? '' : 'hidden'}`}
        style={{ display: activeTab === 'room' ? 'flex' : 'none', flexDirection: 'column', gap: '12px' }}
      >
        <p className={`${styles.manualTip} manual-tip`}>
          房间联机需要部署信令服务器（交换 SDP / ICE 候选自动牵线），属于规划中的里程碑功能。当前版本请使用「邀请对局」：单文件 + 微信互发连接码，支持局域网与可达 IPv6 直连。
        </p>

        <div className={`${styles.row} row`}>
          <button
            id="create-room-btn"
            className={`${styles.btn} ${styles.btnPrimary} ${styles.grow} btn primary grow`}
            disabled={isFileProtocol}
            onClick={onCreateRoom}
          >
            创建房间
          </button>
        </div>

        <div className={`${styles.divider} divider`}>
          <span>或</span>
        </div>

        <div className={`${styles.row} row`}>
          <input
            id="room-input"
            className={`${styles.roomCode} room-code`}
            type="text"
            maxLength={4}
            value={inputRoomCode}
            onChange={(e) => setInputRoomCode(e.target.value.toUpperCase())}
            placeholder="房间号"
            autoComplete="off"
            disabled={isFileProtocol}
          />
          <button
            id="join-room-btn"
            className={`${styles.btn} ${styles.grow} btn grow`}
            disabled={isFileProtocol}
            onClick={onJoinRoom}
          >
            加入房间
          </button>
        </div>

        <div
          id="room-info"
          className={`${styles.roomInfo} room-info ${roomCode ? '' : 'hidden'}`}
          style={{ display: roomCode ? 'flex' : 'none' }}
        >
          <div className={`${styles.roomInfoLine} room-info-line`}>
            房间号 <b id="room-code-text">{roomCode}</b>
            <button
              id="copy-link-btn"
              className={`${styles.btn} ${styles.btnTiny} btn tiny`}
              onClick={onCopyInviteLink}
            >
              复制邀请链接
            </button>
          </div>
          <div id="room-status" className={`${styles.statusLine} status-line`}>
            {roomStatus || '等待对手加入…'}
          </div>
        </div>

        <p
          id="file-tip"
          className={`${styles.manualTip} manual-tip`}
          style={{ display: isFileProtocol ? 'block' : 'none' }}
        >
          当前是 file:// 本地打开，房间联机不可用；请通过服务器访问，或切换到「邀请对局」标签页。
        </p>
      </div>

      {/* 邀请对局面板 */}
      <div
        id="tab-manual"
        className={`tab-panel ${activeTab === 'manual' ? '' : 'hidden'}`}
        style={{ display: activeTab === 'manual' ? 'flex' : 'none', flexDirection: 'column', gap: '12px' }}
      >
        <p className={`${styles.manualTip} manual-tip`}>
          无需服务器：双方通过微信互发连接码，即可建立 P2P 直连。
        </p>

        {/* 步骤指引 */}
        <div
          id="flow-steps"
          className={`${styles.flowSteps} flow-steps ${flow === 'idle' ? 'hidden' : ''}`}
          style={{ display: flow === 'idle' ? 'none' : 'flex' }}
        >
          <span
            id="fstep-1"
            className={`${styles.fstep} fstep ${fstepNumber === 1 ? `${styles.active} active` : ''} ${fstepNumber > 1 ? `${styles.done} done` : ''}`}
          >
            {flow === 'host-wait' ? '① 生成邀请码' : '① 粘贴邀请码'}
          </span>
          <i className={`${styles.farrow} farrow`}>→</i>
          <span
            id="fstep-2"
            className={`${styles.fstep} fstep ${fstepNumber === 2 ? `${styles.active} active` : ''} ${fstepNumber > 2 ? `${styles.done} done` : ''}`}
          >
            {flow === 'host-wait' ? '② 粘贴应答码' : '② 回复应答码'}
          </span>
          <i className={`${styles.farrow} farrow`}>→</i>
          <span
            id="fstep-3"
            className={`${styles.fstep} fstep ${fstepNumber === 3 ? `${styles.active} active` : ''}`}
          >
            ③ 连接成功
          </span>
        </div>

        {/* 入口按钮 */}
        <div
          id="flow-entry"
          className={`${styles.flowEntry} flow-entry ${flow !== 'idle' ? 'hidden' : ''}`}
          style={{ display: flow !== 'idle' ? 'none' : 'flex' }}
        >
          <button
            id="flow-host-btn"
            className={`${styles.btn} ${styles.btnPrimary} ${styles.grow} btn primary grow`}
            onClick={onStartHostFlow}
          >
            创建房间 · 我是邀请方
          </button>
          <button
            id="flow-guest-btn"
            className={`${styles.btn} ${styles.grow} btn grow`}
            onClick={onStartGuestFlow}
          >
            加入房间 · 我是被邀请方
          </button>
        </div>

        {/* 邀请方流程 */}
        <div
          id="flow-host"
          className={`flow-panel ${flow === 'host-wait' ? '' : 'hidden'}`}
          style={{ display: flow === 'host-wait' ? 'block' : 'none' }}
        >
          <div className={`${styles.manualStep} manual-step`}>
            <div className={`${styles.manualStepHead} manual-step-head`}>
              <b>① 邀请码已生成</b>
            </div>

            <div
              id="flow-host-qr-box"
              className={`${styles.qrBox} qr-box ${hostOfferCode ? '' : 'hidden'}`}
              style={{ display: hostOfferCode ? 'flex' : 'none' }}
            >
              <canvas id="flow-host-qr" ref={hostQrRef} className={`${styles.qrCanvas} qr-canvas`} />
              <div className={`${styles.qrTip} qr-tip`}>对方可使用手机「扫一扫」快速对局</div>
            </div>

            <textarea
              id="flow-host-out"
              rows={3}
              readOnly
              value={hostOfferCode}
              placeholder="正在生成…"
              className={`${styles.textarea} ${hostTextFolded ? `${styles.foldedCode} folded-code is-folded` : ''}`}
            />

            <div className={`${styles.row} row`}>
              <button
                id="flow-host-copy"
                className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary} btn small primary`}
                onClick={onCopyHostOffer}
              >
                复制邀请码
              </button>
              <button
                id="flow-host-toggle-text"
                className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost} btn small ghost`}
                onClick={toggleHostText}
              >
                {hostTextFolded ? '查看文本码' : '收起文本码'}
              </button>
            </div>

            <p className={`${styles.wechatTip} wechat-tip`}>📱 面对面直接扫码，或复制邀请码发微信</p>
            <div id="flow-host-wait" className={`${styles.statusLine} status-line`}>
              等待对方回应… <span id="flow-host-timer">{hostTimer}</span>
            </div>
          </div>

          <div className={`${styles.manualStep} manual-step`}>
            <div className={`${styles.manualStepHead} manual-step-head`}>
              <b>② 粘贴对方发回的应答码</b>
              <button
                id="flow-host-scan-btn"
                className={`${styles.btn} ${styles.btnTiny} ${styles.btnPrimary} btn tiny primary`}
                onClick={() => onOpenScanner('host-answer')}
              >
                📷 扫一扫
              </button>
            </div>
            <textarea
              id="flow-host-in"
              rows={3}
              value={hostAnswerInput}
              onChange={(e) => setHostAnswerInput(e.target.value)}
              placeholder="扫描二维码或在此粘贴应答码"
              className={styles.textarea}
            />
            <button
              id="flow-host-finish"
              className={`${styles.btn} ${styles.btnSmall} btn small`}
              onClick={onHostFinish}
            >
              完成连接
            </button>
          </div>
        </div>

        {/* 被邀请方流程 */}
        <div
          id="flow-guest"
          className={`flow-panel ${flow === 'guest-invite' || flow === 'guest-wait' ? '' : 'hidden'}`}
          style={{ display: flow === 'guest-invite' || flow === 'guest-wait' ? 'block' : 'none' }}
        >
          <div className={`${styles.manualStep} manual-step`}>
            <div className={`${styles.manualStepHead} manual-step-head`}>
              <b>① 粘贴创建房间者发来的邀请码</b>
              <button
                id="flow-guest-scan-btn"
                className={`${styles.btn} ${styles.btnTiny} ${styles.btnPrimary} btn tiny primary`}
                onClick={() => onOpenScanner('guest-offer')}
              >
                📷 扫一扫
              </button>
            </div>
            <textarea
              id="flow-guest-in"
              rows={3}
              value={guestOfferInput}
              onChange={(e) => setGuestOfferInput(e.target.value)}
              placeholder="扫描二维码或在此粘贴邀请码"
              className={styles.textarea}
            />
            <button
              id="flow-guest-answer"
              className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary} btn small primary`}
              onClick={onGuestGenerateAnswer}
            >
              生成应答码
            </button>
          </div>

          <div
            id="flow-guest-out-wrap"
            className={`${styles.manualStep} manual-step ${flow === 'guest-wait' ? '' : 'hidden'}`}
            style={{ display: flow === 'guest-wait' ? 'flex' : 'none' }}
          >
            <div className={`${styles.manualStepHead} manual-step-head`}>
              <b>② 应答码已生成</b>
            </div>
            <div
              id="flow-guest-qr-box"
              className={`${styles.qrBox} qr-box ${guestAnswerCode ? '' : 'hidden'}`}
              style={{ display: guestAnswerCode ? 'flex' : 'none' }}
            >
              <canvas id="flow-guest-qr" ref={guestQrRef} className={`${styles.qrCanvas} qr-canvas`} />
              <div className={`${styles.qrTip} qr-tip`}>创建者可使用手机「扫一扫」完成连接</div>
            </div>
            <textarea
              id="flow-guest-out"
              rows={3}
              readOnly
              value={guestAnswerCode}
              className={`${styles.textarea} ${guestTextFolded ? `${styles.foldedCode} folded-code is-folded` : ''}`}
            />
            <div className={`${styles.row} row`}>
              <button
                id="flow-guest-copy"
                className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary} btn small primary`}
                onClick={onCopyGuestAnswer}
              >
                复制应答码
              </button>
              <button
                id="flow-guest-toggle-text"
                className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost} btn small ghost`}
                onClick={toggleGuestText}
              >
                {guestTextFolded ? '查看文本码' : '收起文本码'}
              </button>
            </div>
            <p className={`${styles.wechatTip} wechat-tip`}>📱 面对面展示给创建者扫码，或发回微信</p>
            <div id="flow-guest-wait" className={`${styles.statusLine} status-line`}>
              等待对方完成连接…
            </div>
          </div>
        </div>

        <div
          id="flow-result"
          className={`${styles.flowResult} flow-result ${
            flowResult
              ? flowResult.type === 'bad'
                ? `bad ${styles.bad}`
                : `ok ${styles.ok}`
              : flow === 'connected'
              ? `ok ${styles.ok}`
              : 'hidden'
          }`}
          dangerouslySetInnerHTML={
            flowResult
              ? { __html: flowResult.html }
              : flow === 'connected'
              ? { __html: '<b>✅ 连接成功</b><br>对局数据通过浏览器 P2P DataChannel 直传' }
              : undefined
          }
        />
      </div>
    </div>
  );
};
