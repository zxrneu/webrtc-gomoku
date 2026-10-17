import React, { useRef, useEffect, useState } from 'react';
import type { FlowState, ScannerTarget } from '../../types';
import { renderQrToCanvas } from '../../qr';
import styles from './ConnectionPanel.module.css';

/**
 * 连接配置控制面板入参属性接口
 */
interface ConnectionPanelProps {
  /** 玩家设置的个性化昵称 */
  name: string;
  /** 更新玩家昵称状态 */
  setName: (name: string) => void;
  /** 当前选中的连接模式标签页：'room' (房间信令服务器联机) | 'manual' (面对面/微信邀请对局) */
  activeTab: 'room' | 'manual';
  /** 切换标签页 */
  setActiveTab: (tab: 'room' | 'manual') => void;
  /** 邀请对局手动流程状态机 ('idle' | 'host-wait' | 'guest-invite' | 'guest-wait' | 'connected') */
  flow: FlowState;
  /** 服务器分配的 4 位房间号 */
  roomCode: string;
  /** 用户输入的待加入房间号 */
  inputRoomCode: string;
  /** 设置待加入房间号 */
  setInputRoomCode: (code: string) => void;
  /** 房间联机实时状态提示文案 */
  roomStatus: string;
  /** 邀请方生成的完整压缩 Offer 连接码（Deflate + Base64） */
  hostOfferCode: string;
  /** 被邀请方输入的 Offer 连接码 */
  guestOfferInput: string;
  /** 设置被邀请方输入的 Offer 连接码 */
  setGuestOfferInput: (code: string) => void;
  /** 邀请方输入的对方 Answer 应答码 */
  hostAnswerInput: string;
  /** 设置邀请方输入的对方 Answer 应答码 */
  setHostAnswerInput: (code: string) => void;
  /** 被邀请方生成的 Answer 应答连接码 */
  guestAnswerCode: string;
  /** 邀请方等待超时倒计时文本（如 "118s"） */
  hostTimer: string;
  /** 邀请方文本码是否折叠隐藏（以二维码为主，文本码长折叠省空间） */
  hostTextFolded: boolean;
  /** 切换邀请方文本折叠状态 */
  setHostTextFolded: (fn: (prev: boolean) => boolean) => void;
  /** 被邀请方文本码是否折叠隐藏 */
  guestTextFolded: boolean;
  /** 切换被邀请方文本折叠状态 */
  setGuestTextFolded: (fn: (prev: boolean) => boolean) => void;
  /** 点击创建房间回调（需信令服务器） */
  onCreateRoom: () => void;
  /** 点击加入房间回调（需信令服务器） */
  onJoinRoom: () => void;
  /** 复制房间邀请链接回调 */
  onCopyInviteLink: () => void;
  /** 开启邀请方主导对局流程（发起端生成 Offer） */
  onStartHostFlow: () => void;
  /** 开启被邀请方对局流程（接收端输入 Offer） */
  onStartGuestFlow: () => void;
  /** 点击复制邀请码文本回调 */
  onCopyHostOffer: () => void;
  /** 点击复制应答码文本回调 */
  onCopyGuestAnswer: () => void;
  /** 被邀请方点击生成应答码回调 */
  onGuestGenerateAnswer: () => void;
  /** 邀请方完成最后一步握手回调 */
  onHostFinish: () => void;
  /** 打开摄像头/相册扫描二维码弹窗回调 */
  onOpenScanner: (target: ScannerTarget) => void;
  /** 连接结果反馈横幅数据对象（含类型 'ok'|'bad' 与富文本 html） */
  flowResult: { type: string; html: string } | null;
}

/**
 * 连接与对局准备控制面板 (ConnectionPanel)
 * 职责：
 * 1. 玩家身份维护：昵称录入与保存
 * 2. 双模式切换：
 *    - 「房间联机」：基于 WebSocket 自动信令交换的 4 位房间号配对
 *    - 「邀请对局」：彻底无服务器的 WebRTC Vanilla ICE 离线信令交换（支持面对面二维码扫码与微信长文本互发）
 * 3. 动态三步指引 (fstep 1 -> 2 -> 3)，平滑引导非技术用户完成复杂的 P2P 握手
 */
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
  // 检测当前是否是 file:// 协议本地离线双击打开（该模式下无法连接外置 WebSocket 服务器）
  const isFileProtocol =
    typeof window !== 'undefined' && window.location.protocol === 'file:';

  /** 邀请方 Offer 二维码 Canvas DOM 引用 */
  const hostQrRef = useRef<HTMLCanvasElement | null>(null);
  /** 被邀请方 Answer 二维码 Canvas DOM 引用 */
  const guestQrRef = useRef<HTMLCanvasElement | null>(null);

  /** 连接成功后是否展开完整的连接配置信息（默认收起为紧凑条以节省垂直空间） */
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const isCompact = flow === 'connected' && !detailsExpanded;

  // 当邀请码 Offer 生成时，调用 qr.ts 绘制离散对齐的清晰黑白二维码
  useEffect(() => {
    if (hostOfferCode && hostQrRef.current) {
      renderQrToCanvas(hostQrRef.current, hostOfferCode);
    }
  }, [hostOfferCode, flow]);

  // 当应答码 Answer 生成时，自动绘制对应二维码
  useEffect(() => {
    if (guestAnswerCode && guestQrRef.current) {
      renderQrToCanvas(guestQrRef.current, guestAnswerCode);
    }
  }, [guestAnswerCode, flow]);

  // 将复杂流转状态映射为线性的步骤序号 (0~3)，驱动顶部进度指示器高亮
  const fstepNumber =
    flow === 'connected'
      ? 3
      : flow === 'guest-wait'
      ? 2
      : flow === 'host-wait' || flow === 'guest-invite'
      ? 1
      : 0;

  /** 切换邀请方长文本折叠/展开 */
  const toggleHostText = () => {
    const out = document.getElementById('flow-host-out');
    const btn = document.getElementById('flow-host-toggle-text');
    const isCurrentlyFolded = out ? out.classList.contains('is-folded') : hostTextFolded;
    const next = !isCurrentlyFolded;
    if (out) out.classList.toggle('is-folded', next);
    if (btn) btn.textContent = next ? '查看文本码' : '收起文本码';
    setHostTextFolded(() => next);
  };

  /** 切换被邀请方长文本折叠/展开 */
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
    <div id="connect-card" className={`${styles.connectCard} ${isCompact ? styles.compact : ''} card`}>
      {/* 对局已连接时的紧凑状态条与展开详情按钮 */}
      {flow === 'connected' && (
        <div className={styles.compactHeader}>
          <div className={styles.compactBadge}>
            <span className={styles.compactDot} />
            <span className={styles.compactTitle}>
              {activeTab === 'room' && roomCode ? `房间 ${roomCode}` : 'P2P 对局已直连'}
            </span>
          </div>
          <button
            id="toggle-connect-details-btn"
            type="button"
            className={`${styles.btn} ${styles.btnTiny} ${styles.btnGhost} ${styles.compactToggle}`}
            onClick={() => setDetailsExpanded((v: boolean) => !v)}
          >
            {detailsExpanded ? '收起 ▴' : '连接设置 ▾'}
          </button>
        </div>
      )}

      {/* 玩家昵称输入区 */}
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

      {/* 联机方式切换标签页 */}
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

      {/* ======================= 标签页 1：房间联机（需信令服务器） ======================= */}
      <div
        id="tab-room"
        className={`tab-panel ${activeTab === 'room' ? '' : 'hidden'}`}
        style={{ display: activeTab === 'room' ? 'flex' : 'none', flexDirection: 'column', gap: '12px' }}
      >
        <p className={`${styles.manualTip} manual-tip`}>
          房间联机需要部署信令服务器（交换 SDP / ICE 候选自动牵线），属于规划中的里程碑功能。当前版本请使用「邀请对局」：单文件 + 微信互发连接码，支持局域网与可达 IPv6 直连。
        </p>

        {/* 创建房间按钮 */}
        <div className={`${styles.row} ${styles.createRoomRow} row`}>
          <button
            id="create-room-btn"
            className={`${styles.btn} ${styles.btnPrimary} ${styles.grow} btn primary grow`}
            disabled={isFileProtocol}
            onClick={onCreateRoom}
          >
            {flow === 'connected' ? '换房' : '创建房间'}
          </button>
        </div>

        <div className={`${styles.divider} divider`}>
          <span>或</span>
        </div>

        {/* 输入房间号加入 */}
        <div className={`${styles.row} ${styles.roomInputRow} row`}>
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

        {/* 房间信息与链接复制 */}
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

        {/* file:// 离线协议下的警示提示 */}
        <p
          id="file-tip"
          className={`${styles.manualTip} manual-tip`}
          style={{ display: isFileProtocol ? 'block' : 'none' }}
        >
          当前是 file:// 本地打开，房间联机不可用；请通过服务器访问，或切换到「邀请对局」标签页。
        </p>
      </div>

      {/* ======================= 标签页 2：邀请对局（无服务器 Vanilla ICE） ======================= */}
      <div
        id="tab-manual"
        className={`tab-panel ${activeTab === 'manual' ? '' : 'hidden'}`}
        style={{ display: activeTab === 'manual' ? 'flex' : 'none', flexDirection: 'column', gap: '12px' }}
      >
        <p className={`${styles.manualTip} manual-tip`}>
          无需服务器：双方通过微信互发连接码，即可建立 P2P 直连。
        </p>

        {/* 步骤条指引：① 生成/粘贴邀请码 -> ② 回复/粘贴应答码 -> ③ 连接成功 */}
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

        {/* 初始身份选择入口按钮 (创建房间者 vs 加入房间者) */}
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

        {/* ---------------- 邀请方流程（Host Flow） ---------------- */}
        <div
          id="flow-host"
          className={`flow-panel ${flow === 'host-wait' ? '' : 'hidden'}`}
          style={{ display: flow === 'host-wait' ? 'block' : 'none' }}
        >
          {/* 步骤 ①：展示 Offer 二维码与文本码 */}
          <div className={`${styles.manualStep} manual-step`}>
            <div className={`${styles.manualStepHead} manual-step-head`}>
              <b>① 邀请码已生成</b>
            </div>

            {/* 二维码展示容器 */}
            <div
              id="flow-host-qr-box"
              className={`${styles.qrBox} qr-box ${hostOfferCode ? '' : 'hidden'}`}
              style={{ display: hostOfferCode ? 'flex' : 'none' }}
            >
              <canvas id="flow-host-qr" ref={hostQrRef} className={`${styles.qrCanvas} qr-canvas`} />
              <div className={`${styles.qrTip} qr-tip`}>对方可使用手机「扫一扫」快速对局</div>
            </div>

            {/* 压缩 Base64 文本码，默认折叠 */}
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

          {/* 步骤 ②：粘贴对方发回的 Answer 应答码 */}
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

        {/* ---------------- 被邀请方流程（Guest Flow） ---------------- */}
        <div
          id="flow-guest"
          className={`flow-panel ${flow === 'guest-invite' || flow === 'guest-wait' ? '' : 'hidden'}`}
          style={{ display: flow === 'guest-invite' || flow === 'guest-wait' ? 'block' : 'none' }}
        >
          {/* 步骤 ①：被邀请方粘贴创建者的邀请码 */}
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

          {/* 步骤 ②：生成应答码并展示给创建者 */}
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

        {/* ---------------- 握手结果横幅（连接成功或失败报警） ---------------- */}
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
