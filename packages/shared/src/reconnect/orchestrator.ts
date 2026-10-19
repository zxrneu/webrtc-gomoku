/**
 * ============================================================================
 * 重连编排器（ConnectionManager）
 * ============================================================================
 * 职责：把「纯函数」串成真实行为。
 * - 状态迁移：全部交给 `reduce()`（本文件不自己写 if-else 状态判断）；
 * - 时间：全部经注入的 `Clock`；
 * - 随机：经注入的 `random`；
 * - IO：全部经注入的 `SignalTransport` / `P2pTransport`；
 * - 日志：全部经注入的 `Logger`（字段白名单由 `LogEvent` 类型保证）。
 *
 * 因此本文件虽然「有状态、有定时器」，仍然零 DOM、零全局 IO，
 * 可以在 Node 里用假实现毫秒级跑完（AGENTS §2 D、§3）。
 *
 * 关键流程（对齐 architecture.md §5）：
 * ① 建房/入房 → created/joined → 房主 attach(true) → DC open → CONNECTED
 * ② WS 断开 → 退避 → resume → P2P 恢复（ICE restart ×2 → 重建 ×1）→ sync 对账
 * ③ 仅 P2P 断 → 5s 去抖（在适配器）→ ICE restart 阶梯 → sync
 * ④ 服务端重启 → resume 被拒 → FAILED（保留棋谱，给出同房号重建入口）
 */

import type { Move } from '@webrtc-gomoku/core';

import type { GameMessage, ServerErrorMsg, ServerSignalingMsg, SyncMsg } from '../types';
import { classifyFailure, isUnsupportedMessageError, type FailReason } from './classify';
import { hostOf, type Logger } from './log';
import type { Clock, P2pEvent, P2pTransport, SignalEvent, SignalTransport } from './ports';
import { nextDelayMs, type ReconnectPolicy } from './policy';
import { initialSnapshot, reduce, type ConnEvent, type ConnSnapshot } from './state';
import { deriveStatus, type ConnectionStatus } from './status';
import { planSync, replayMoves } from './sync';

/** 编排器向业务层发出的「副作用」事件（App 只做 UI 反应） */
export type ConnSideEffect =
  /** 首次建立直连（非恢复），用于「P2P 连接已建立」提示与 hello 交换 */
  | { type: 'connected' }
  | { type: 'restored'; via: 'ice-restart' | 'rebuild' | 'ws-only'; movesSynced: number }
  | { type: 'failed'; reason: FailReason; message?: string }
  | { type: 'peer-offline'; graceSecs: number }
  | { type: 'peer-online' }
  | { type: 'peer-gone' }
  | { type: 'room-invalid'; room: string; message?: string }
  /** 会话已提交（首次建房/入房或换房成功）：UI 在此清盘并切换角色 */
  | { type: 'room-ready'; room: string; role: 'host' | 'guest' }
  /** 换房被服务端拒绝（房号不存在/已满/非法）：只 toast 原文，当前对局零变化 */
  | { type: 'join-rejected'; message: string }
  | { type: 'sync-applied'; appended: number; mismatch: boolean }
  | { type: 'degraded-to-v1' };

/** 编排器依赖（全部可注入） */
export interface ConnectionManagerDeps {
  /** 信令通道 */
  signal: SignalTransport;
  /** P2P 通道 */
  p2p: P2pTransport;
  /** 注入的时钟 */
  clock: Clock;
  /** 注入的随机源（返回 [0,1)） */
  random: () => number;
  /** 策略参数 */
  policy: ReconnectPolicy;
  /** 日志出口 */
  logger: Logger;
  /** 信令 URL（shared 不知道 location，由 web 提供） */
  signalUrl: string;
  /** 取本地棋谱快照（对账用） */
  getLocalMoves: () => readonly Move[];
  /** 加入方对账后要求 App 重放棋盘 */
  onMovesReplaced: (moves: readonly Move[]) => void;
  /** 状态变化回调（UI 唯一状态源） */
  onStatus: (s: ConnectionStatus) => void;
  /** 副作用回调（toast / 系统消息 / 按钮） */
  onEvent: (e: ConnSideEffect) => void;
  /** 非控制类局内消息（落子 / 聊天 / 悔棋…）转发给业务层 */
  onGameMessage: (msg: GameMessage) => void;
  /** 当前是否在线（navigator.onLine） */
  isOnline: () => boolean;
}

/** 业务层唯一可调用的连接管理器接口 */
export interface ConnectionManager {
  /** 创建房间（房主，恒为 offerer） */
  createRoom(code: string, name?: string): void;
  /** 加入房间（加入方，只应答） */
  joinRoom(code: string, name: string): void;
  /** 立即重试（跳过剩余退避；FAILED 下重置 attempt） */
  retryNow(): void;
  /** 主动离开（不留座位） */
  leave(): void;
  /** 页面可见性变化（隐藏=修饰符 paused） */
  setPageVisible(visible: boolean): void;
  /** 落子后调用：检测 DC 未就绪（R9，禁止静默） */
  notifyLocalMove(): void;
  /** 对手主动 bye（局内协议）→ 视为 PEER_GONE */
  notifyPeerGone(): void;
  /** 当前状态 */
  getStatus(): ConnectionStatus;
  /** 释放全部定时器与连接 */
  dispose(): void;
}

/** 恢复方式（用于 conn.restore.via） */
type RestoreVia = 'ice-restart' | 'rebuild' | 'ws-only';

/**
 * 创建重连编排器。
 *
 * @param deps 全部依赖（时钟 / 随机 / 传输 / 日志 / 回调）
 * @returns 业务层可用的 ConnectionManager
 */
export function createConnectionManager(deps: ConnectionManagerDeps): ConnectionManager {
  const policy: ReconnectPolicy = deps.policy;
  const clock: Clock = deps.clock;
  const logger: Logger = deps.logger;

  /** 状态机快照（唯一状态源） */
  let snap: ConnSnapshot = initialSnapshot(clock.now());
  let disposed = false;

  // ---------------- 会话标识 ----------------
  let role: 'host' | 'guest' | null = null;
  let room: string | null = null;
  let peerId: string | null = null;
  let token: string | null = null;
  let hasPeer = false;
  let myName = '';
  /** 连接建立后要发的第一条上行消息 */
  let pendingIntent: 'none' | 'create' | 'join' | 'resume' = 'none';
  let pendingRoom: string | null = null;
  /** 当前 incident 是否处于「恢复」语义（决定恢复完成后要不要发 restored） */
  let restorePending = false;

  // ---------------- 换房（confirm-then-commit） ----------------
  /**
   * 待确认的换房意图。
   *
   * `joinRoom`/`createRoom` 在**已有会话**时**不得**立即改写 `room`、关闭现有 p2p
   * 或重连 socket —— 否则「输错房号」会把正在进行的对局整局拆掉（旧版行为是只 toast）。
   * 这里只把意图记下来并复用当前 socket 发一条 `join`/`create`；
   * 服务端 `joined`/`created` 到达后才提交新会话，`error` 到达则丢弃意图、对局零变化。
   */
  let switchIntent: 'create' | 'join' | null = null;
  let switchName = '';

  // ---------------- 定时器句柄（单链 setTimeout，禁止 setInterval，ADR-3） ----------------
  let retryTimer: number | null = null;
  let incidentTimer: number | null = null;
  let p2pDelayTimer: number | null = null;
  let p2pStepTimer: number | null = null;
  let peerWaitTimer: number | null = null;
  let syncTimer: number | null = null;
  let negotiationTimer: number | null = null;

  // ---------------- 对账 ----------------
  let syncRev = 0;
  let awaitingAckRev: number | null = null;

  // ---------------- 一次性探测标记 ----------------
  let dcNotOpenReported = false;
  let p2pProbeStarted = false;

  let lastVia: RestoreVia = 'ws-only';
  let incidentStartMs = clock.now();
  /** conn.fail 每个 incident 只记 1 条 */
  let failedReported = false;

  const now = (): number => clock.now();

  /* ==========================================================================
   * 快照与状态发布
   * ======================================================================== */

  function publish(): void {
    deps.onStatus(deriveStatus(snap, policy, now()));
  }

  /** 派发状态机事件；返回是否真的发生了迁移（非法/被拒时返回 false） */
  function dispatch(event: ConnEvent): boolean {
    const prev = snap;
    const next = reduce(prev, event, policy);
    if (next === prev) return false;
    snap = next;
    updateNegotiationTimeout();
    if (next.state !== prev.state) {
      logger.log({
        ev: 'conn.state',
        from: prev.state,
        to: next.state,
        attempt: next.attempt,
        reason: next.reason,
        sinceMs: next.since,
      });
    }
    publish();
    return true;
  }

  /**
   * 写入编排器自有的快照字段（`nextRetryAtMs` 依赖 clock/random，不是状态迁移）。
   * 刻意不经 reducer：reducer 必须保持纯函数，不能读时钟或随机数。
   */
  function patch(fields: Partial<ConnSnapshot>): void {
    snap = { ...snap, ...fields };
    publish();
  }

  /* ==========================================================================
   * 定时器管理
   * ======================================================================== */

  function clearHandle(handle: number | null): null {
    if (handle !== null) clock.clearTimeout(handle);
    return null;
  }

  function clearRetryTimer(): void {
    retryTimer = clearHandle(retryTimer);
  }
  /** 首次建连失败必须可见；候选消息不能不断延长同一次协商。 */
  function updateNegotiationTimeout(): void {
    const isNegotiating = snap.state === 'NEGOTIATING';
    const isWaitingForOffer = snap.state === 'ROOM_WAITING' && role === 'guest' && hasPeer && !restorePending;
    if (!isNegotiating && !isWaitingForOffer) {
      negotiationTimer = clearHandle(negotiationTimer);
      return;
    }
    if (negotiationTimer !== null) return;
    negotiationTimer = clock.setTimeout(() => {
      negotiationTimer = null;
      if (!disposed) failSession('ICE_FAILED');
    }, policy.p2p.negotiationTimeoutMs);
  }
  function clearP2pTimers(): void {
    p2pDelayTimer = clearHandle(p2pDelayTimer);
    p2pStepTimer = clearHandle(p2pStepTimer);
  }
  function clearPeerWait(): void {
    peerWaitTimer = clearHandle(peerWaitTimer);
  }
  function clearSyncTimer(): void {
    syncTimer = clearHandle(syncTimer);
  }
  function clearIncidentTimer(): void {
    incidentTimer = clearHandle(incidentTimer);
  }
  function clearAllTimers(): void {
    negotiationTimer = clearHandle(negotiationTimer);
    clearRetryTimer();
    clearP2pTimers();
    clearPeerWait();
    clearSyncTimer();
    clearIncidentTimer();
  }

  /* ==========================================================================
   * 会话建立
   * ======================================================================== */

  function startSession(intent: 'create' | 'join', code: string, name: string): void {
    clearAllTimers();
    disposed = false;
    switchIntent = null;
    switchName = '';
    role = intent === 'create' ? 'host' : 'guest';
    room = code;
    myName = name;
    peerId = null;
    token = null;
    hasPeer = false;
    syncRev = 0;
    awaitingAckRev = null;
    restorePending = false;
    dcNotOpenReported = false;
    p2pProbeStarted = false;
    failedReported = false;
    lastVia = 'ws-only';
    pendingIntent = intent;
    pendingRoom = code;
    incidentStartMs = now();
    snap = initialSnapshot(now());
    deps.p2p.close();
    dispatch({ type: 'START', at: now(), role, room: code });
    deps.signal.connect(deps.signalUrl, policy.connectTimeoutMs);
  }

  /** 当前是否有一个「仍在进行」的会话（IDLE / FAILED 之外都算） */
  function hasLiveSession(): boolean {
    return snap.state !== 'IDLE' && snap.state !== 'FAILED';
  }

  /**
   * 发起换房（不提交）：只发一条 `join`/`create`，其余状态一律不动。
   *
   * @param intent 换房目标语义
   * @param code 目标房间号（已大写）
   * @param name 昵称
   */
  function beginSwitch(intent: 'create' | 'join', code: string, name: string): void {
    switchIntent = intent;
    switchName = name;
    if (intent === 'create') {
      deps.signal.send({ t: 'create', room: code, name });
      return;
    }
    deps.signal.send({ t: 'join', room: code, name });
  }

  /**
   * 服务端确认换房成功：此时才真正切换会话（重置快照、丢弃旧 PC、进入 ROOM_WAITING）。
   *
   * 复用**同一个** socket —— 服务端在 `create`/`join` 成功时已把旧座位释放
   * （`rooms.ts` 的「前置校验全部通过后才 leave」），因此对端会立刻收到 `peer-left`，
   * 不需要也不应该重连。
   *
   * @param confirmedRoom 服务端下发的房间号
   * @param confirmedRole 换房后的角色
   */
  function commitSwitch(confirmedRoom: string, confirmedRole: 'host' | 'guest'): void {
    clearAllTimers();
    role = confirmedRole;
    hasPeer = confirmedRole === 'guest';
    room = confirmedRoom;
    myName = switchName || myName;
    syncRev = 0;
    awaitingAckRev = null;
    restorePending = false;
    dcNotOpenReported = false;
    p2pProbeStarted = false;
    failedReported = false;
    lastVia = 'ws-only';
    switchIntent = null;
    switchName = '';
    pendingIntent = 'none';
    pendingRoom = confirmedRoom;
    incidentStartMs = now();
    snap = initialSnapshot(now());
    deps.p2p.close();
    dispatch({ type: 'START', at: now(), role, room: confirmedRoom });
    dispatch({ type: 'ROOM_READY', at: now(), room: confirmedRoom });
    deps.onEvent({ type: 'room-ready', room: confirmedRoom, role });
  }

  /** 服务端拒绝换房：丢弃意图，当前对局保持原样，只把服务端原文交给 UI */
  function abortSwitch(message: string): void {
    switchIntent = null;
    switchName = '';
    deps.onEvent({ type: 'join-rejected', message });
  }

  /**
   * 对手真的离开后「重新挂回房间」。
   *
   * `PEER_GONE` 把状态机收敛到 IDLE（清盘语义），但此时本端**仍在房间里**、
   * socket 也还开着，正确的用户可见状态是「房间 A8B2 · 等待对手加入…」而不是「未连接」。
   * 因此紧接着走一次 IDLE → SIGNAL_CONNECTING → ROOM_WAITING 的合法迁移，
   * 既不新增状态、也不违反 K1 的非法迁移表（如 CONNECTED → ROOM_WAITING）。
   */
  function rearmRoom(): void {
    const targetRoom = snap.room ?? room;
    if (!targetRoom || !role) return;
    if (deps.signal.readyState !== 'open') return;

    clearAllTimers();
    deps.p2p.close(); // 对手已走，旧 PC 必须丢弃
    room = targetRoom;
    hasPeer = false;
    syncRev = 0;
    awaitingAckRev = null;
    restorePending = false;
    dcNotOpenReported = false;
    p2pProbeStarted = false;
    lastVia = 'ws-only';
    pendingIntent = 'none';
    pendingRoom = targetRoom;
    incidentStartMs = now();
    snap = initialSnapshot(now());
    dispatch({ type: 'START', at: now(), role, room: targetRoom });
    dispatch({ type: 'ROOM_READY', at: now(), room: targetRoom });
  }

  function openSignal(): void {
    deps.signal.connect(deps.signalUrl, policy.connectTimeoutMs);
  }

  function sendJoin(): void {
    if (!pendingRoom) return;
    deps.signal.send({ t: 'join', room: pendingRoom, name: myName });
  }

  function sendPendingIntent(): void {
    if (pendingIntent === 'none' || !pendingRoom) return;

    if (pendingIntent === 'resume' && peerId && token) {
      if (snap.serverCompat === 'v1') {
        // 旧服务端不认识 resume：跳过它，直接降级为「重新 join + 新建 PC」（K8-2）
        pendingIntent = 'join';
        sendJoin();
        return;
      }
      deps.signal.send({ t: 'resume', room: pendingRoom, peerId, token });
      return;
    }

    if (pendingIntent === 'create') {
      deps.signal.send({ t: 'create', room: pendingRoom, name: myName });
      return;
    }

    sendJoin();
  }

  /* ==========================================================================
   * 信令事件
   * ======================================================================== */

  function handleSignalEvent(e: SignalEvent): void {
    if (disposed) return;
    switch (e.type) {
      case 'open':
        dispatch({ type: 'SIGNAL_OPEN', at: now() });
        sendPendingIntent();
        break;
      case 'closed':
        if (e.intentional) return;
        onSignalLost(classifyFailure({ source: 'ws-close', online: deps.isOnline() }));
        break;
      case 'error':
        onSignalLost(classifyFailure({ source: 'ws-error', online: deps.isOnline() }));
        break;
      case 'connect-timeout':
        onSignalLost(classifyFailure({ source: 'connect-timeout', online: deps.isOnline() }));
        break;
      case 'heartbeat-dead':
        onSignalLost(classifyFailure({ source: 'ws-heartbeat', online: deps.isOnline() }));
        break;
      case 'probe-unsupported':
        onProbeUnsupported(e.probe);
        break;
      case 'msg':
        onServerMessage(e.msg);
        break;
      default:
        break;
    }
  }

  function onServerMessage(msg: ServerSignalingMsg): void {
    switch (msg.t) {
      case 'created':
        peerId = msg.peerId;
        token = msg.token ?? null;
        if (switchIntent) {
          commitSwitch(msg.room, 'host');
          break;
        }
        role = 'host';
        room = msg.room;
        pendingRoom = msg.room;
        pendingIntent = 'none';
        clearRetryTimer();
        dispatch({ type: 'ROOM_READY', at: now(), room: msg.room });
        // 恢复语义（旧服务端降级路径）绝不能抛 room-ready，否则 UI 会清掉棋谱
        if (restorePending) {
          onSessionRestored();
          break;
        }
        deps.onEvent({ type: 'room-ready', room: msg.room, role: 'host' });
        break;

      case 'joined':
        hasPeer = true;
        peerId = msg.peerId;
        token = msg.token ?? null;
        if (switchIntent) {
          commitSwitch(msg.room, switchIntent === 'create' ? 'host' : 'guest');
          break;
        }
        // 降级路径下房主也会走 join：不得把角色改回 guest（房主恒为 offerer）
        role = role ?? 'guest';
        room = msg.room;
        pendingRoom = msg.room;
        pendingIntent = 'none';
        clearRetryTimer();
        dispatch({ type: 'ROOM_READY', at: now(), room: msg.room });
        // 恢复语义（旧服务端降级路径）绝不能抛 room-ready，否则 UI 会清掉棋谱
        if (restorePending) {
          onSessionRestored();
          break;
        }
        deps.onEvent({ type: 'room-ready', room: msg.room, role });
        break;

      case 'resumed': {
        const peerLeft = hasPeer && msg.peerPresent === false;
        hasPeer = msg.peerPresent ?? hasPeer;
        peerId = msg.peerId;
        token = msg.token;
        room = msg.room;
        pendingRoom = msg.room;
        pendingIntent = 'none';
        clearRetryTimer();
        dispatch({ type: 'ROOM_READY', at: now(), room: msg.room });
        if (peerLeft) {
          dispatch({ type: 'PEER_GONE', at: now() });
          deps.onEvent({ type: 'peer-gone' });
          rearmRoom();
          break;
        }
        onSessionRestored();
        break;
      }

      case 'peer-joined':
        hasPeer = true;
        if (dispatch({ type: 'PEER_PRESENT', at: now() }) && role === 'host') {
          // 房主恒为 offerer（ADR-1），加入方只等待 offer
          deps.p2p.attach(true);
        }
        break;

      case 'peer-online':
        hasPeer = true;
        patch({ peerOfflineUntilMs: null });
        deps.onEvent({ type: 'peer-online' });
        if (snap.state === 'P2P_RECOVERING') {
          clearPeerWait();
          if (role === 'host') runP2pStep();
          break;
        }
        // 宽限期内本端 DC 已断（但状态仍停在 CONNECTED）：对手回来了，立刻重建直连
        if (snap.state === 'CONNECTED' && !deps.p2p.isDcOpen()) {
          onP2pLost('ICE_FAILED');
        }
        break;

      case 'peer-offline':
        if (dispatch({ type: 'PEER_OFFLINE', at: now(), graceSecs: msg.graceSec })) {
          clearP2pTimers();
          clearPeerWait();
          clearSyncTimer();
          awaitingAckRev = null;
          deps.onEvent({ type: 'peer-offline', graceSecs: msg.graceSec });
        }
        break;

      case 'peer-left':
        // 只在宽限期超时后才会到达（Q-A 已回签）：对手真的走了 → 清盘
        clearAllTimers();
        if (dispatch({ type: 'PEER_GONE', at: now() })) {
          deps.onEvent({ type: 'peer-gone' });
          rearmRoom();
        }
        break;

      case 'signal':
        onRemoteSignal(msg.data);
        break;

      case 'error':
        onServerError(msg);
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  function onRemoteSignal(data: unknown): void {
    if (!data) return;
    if (snap.state === 'IDLE' || snap.state === 'FAILED') return;
    if (snap.state === 'ROOM_WAITING') {
      dispatch({ type: 'PEER_PRESENT', at: now() });
    }
    const task = deps.p2p.applyRemoteSignal(data);
    task.catch(() => {
      // 本端 PC 已死、无法应用对端 offer → 走 P2P 恢复阶梯
      onP2pLost('ICE_FAILED');
    });
  }

  function onServerError(msg: ServerErrorMsg): void {
    if (isUnsupportedMessageError(msg.message)) {
      onProbeUnsupported('ping');
      return;
    }
    if (switchIntent) {
      // 换房被拒（房号不存在/已满/非法）：当前对局零变化，只把服务端原文交给 UI
      abortSwitch(msg.message);
      return;
    }
    const isResume = pendingIntent === 'resume';
    const reason: FailReason = isResume ? 'SERVER_RESTART' : 'SERVER_REJECTED';
    const targetRoom = room ?? pendingRoom ?? '';
    failSession(reason, msg.message);
    deps.onEvent({ type: 'room-invalid', room: targetRoom, message: msg.message });
  }

  /**
   * 命中「旧服务端」探测：关闭 L2 心跳（由适配器完成）、跳过 resume、降级重建。
   * 只探测一次（`serverCompat === 'v1'` 后直接返回）。
   */
  function onProbeUnsupported(probe: 'ping' | 'resume'): void {
    if (snap.serverCompat === 'v1') return;
    dispatch({ type: 'SERVER_COMPAT', at: now(), compat: 'v1' });
    logger.log({ ev: 'conn.compat', server: 'v1' });
    deps.onEvent({ type: 'degraded-to-v1' });
    if (probe === 'resume') {
      pendingIntent = 'join';
      sendJoin();
    }
  }

  /* ==========================================================================
   * 失败与退避
   * ======================================================================== */

  /** 记录一次终态失败日志（每 incident 至多 1 条） */
  function reportFailure(reason: FailReason): void {
    if (failedReported) return;
    failedReported = true;
    logger.log({
      ev: 'conn.fail',
      reason,
      attempt: snap.attempt,
      totalMs: Math.max(0, now() - incidentStartMs),
      online: deps.isOnline(),
      visibility: snap.paused ? 'hidden' : 'visible',
    });
  }

  /**
   * 进入 FAILED 终态：停掉全部定时器。
   *
   * **信令 socket 只在「它本身已经不可用」时才关闭**（省电，PRD §7）。
   * 纯 P2P 终态（`ICE_FAILED`，对端在线但打洞失败）时 socket 仍然健康：
   * 它是对手 resume 回来、以及用户点「立即重试」的唯一通道，绝不能顺手关掉。
   */
  function failSession(reason: FailReason, message?: string): void {
    if (!dispatch({ type: 'FATAL', at: now(), reason })) return;
    clearAllTimers();
    if (reason !== 'ICE_FAILED' && reason !== 'DC_NOT_OPEN') {
      deps.signal.close(1000);
    }
    reportFailure(reason);
    deps.onEvent({ type: 'failed', reason, message });
  }

  function onSignalLost(reason: FailReason): void {
    if (disposed) return;
    if (snap.state === 'IDLE' || snap.state === 'FAILED') return;

    const prevState = snap.state;
    if (prevState === 'CONNECTED') {
      // 对局中掉线 = 新 incident：重试计数从 0 开始
      patch({ attempt: 0 });
    }

    if (!dispatch({ type: 'SIGNAL_LOST', at: now(), reason })) return;

    if (prevState !== 'RECONNECTING') incidentStartMs = now();
    clearIncidentTimer();
    clearSyncTimer();
    clearP2pTimers();
    clearPeerWait();

    if (snap.attempt > policy.maxAttempts) {
      // 6 次重试已全部用尽
      failSession('POLICY_EXHAUSTED');
      return;
    }
    scheduleRetry();
  }

  function scheduleRetry(): void {
    clearRetryTimer();
    if (snap.paused) return; // 页面隐藏：不排定时器，RESUME 时立即重试

    const delay = nextDelayMs(snap.attempt, policy, deps.random);
    patch({ nextRetryAtMs: now() + delay });
    logger.log({
      ev: 'conn.retry',
      attempt: snap.attempt,
      delayMs: delay,
      reason: snap.reason ?? 'WS_CLOSED',
      urlHost: hostOf(deps.signalUrl),
    });
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      onRetryDue();
    }, delay);
  }

  function onRetryDue(): void {
    if (disposed) return;
    // paused 时被 reducer 拒绝；此时不重排定时器，等 setPageVisible(true) 立即重试
    if (!dispatch({ type: 'RETRY_DUE', at: now() })) return;
    prepareReconnect();
    openSignal();
  }

  /** 未拿到座位前重试原始请求；只有已确认的会话才走恢复。 */
  function prepareReconnect(): void {
    if (!peerId) return;
    pendingIntent = 'resume';
    restorePending = true;
  }

  /* ==========================================================================
   * P2P 事件与恢复阶梯
   * ======================================================================== */

  function handleP2pEvent(e: P2pEvent): void {
    if (disposed) return;
    switch (e.type) {
      case 'dc-open':
        onDcOpen();
        break;
      case 'dc-closed':
        if (snap.state === 'CONNECTED') onP2pLost('DC_NOT_OPEN');
        break;
      case 'pc-disconnected-settled':
      case 'pc-failed':
      case 'ice-restart-failed':
        onP2pLost('ICE_FAILED');
        break;
      case 'msg':
        onGameMessage(e.msg);
        break;
      case 'pc-state':
        // ICE restart 沿用原 DC，不会再次触发 dc-open。
        if (e.state === 'connected' && snap.state === 'P2P_RECOVERING' && deps.p2p.isDcOpen()) {
          onDcOpen();
        }
        break;
      case 'signal-out':
        // signal-out 由 web 层注入的 signalOut 直接转发
        break;
      default:
        break;
    }
  }

  function onP2pLost(reason: FailReason): void {
    if (disposed) return;
    // 阶梯已在进行：不要重复计数（dc-closed + pc-failed 常常成对到达）
    if (snap.state === 'P2P_RECOVERING') return;
    if (snap.state !== 'CONNECTED' && snap.state !== 'NEGOTIATING') return;
    /**
     * 对手正在宽限期内（`peerOfflineUntilMs !== null`）：**根因在对端离线，不在本机网络**。
     * 此时对端根本不在线，ICE restart / rebuild 必然失败，若照常走阶梯会在 ~20s 后
     * 误判成「直连建立失败（可能处于对称 NAT）」并进入 FAILED —— 而 FAILED 之后连
     * 宽限到期的 `peer-left` 都收不下，棋盘永不清盘（QA 缺陷 1）。
     *
     * 正确做法：保持 CONNECTED + 锁盘 + 宽限倒计时，等对手 `peer-online` 再恢复。
     */
    if (snap.peerOfflineUntilMs !== null) return;
    if (!dispatch({ type: 'P2P_LOST', at: now(), reason })) return;
    beginP2pRestore();
    if (role === 'host') runP2pStep();
  }

  /** P2P 单独掉线也要进入对账恢复语义。 */
  function beginP2pRestore(): void {
    if (restorePending) return;
    restorePending = true;
    incidentStartMs = now();
    failedReported = false;
    clearIncidentTimer();
  }

  /** 装填「本步恢复是否成功」的超时；超时则进入下一步 */
  function armStepTimeout(): void {
    p2pStepTimer = clearHandle(p2pStepTimer);
    p2pStepTimer = clock.setTimeout(() => {
      p2pStepTimer = null;
      if (disposed || snap.state !== 'P2P_RECOVERING') return;
      if (!dispatch({ type: 'P2P_LOST', at: now(), reason: 'ICE_FAILED' })) return;
      runP2pStep();
    }, policy.p2p.peerOnlineWaitMs);
  }

  /**
   * P2P 恢复阶梯（ADR-2）：ICE restart ×2（0s / 3s）→ 全量重建 ×1 → 终态。
   * 只有房主执行；加入方永远只应答（ADR-1）。
   */
  function runP2pStep(): void {
    if (disposed || role !== 'host') return;
    clearP2pTimers();

    const attempt = Math.max(1, snap.p2pAttempt);
    const iceAttempts = policy.p2p.iceRestartAttempts;
    const rebuildAttempts = policy.p2p.rebuildAttempts;

    if (attempt > iceAttempts + rebuildAttempts) {
      clearAllTimers();
      // 对手仍在宽限期内：阶梯耗尽只是「本轮恢复尝试结束」，不是会话终态（缺陷 1）
      if (snap.peerOfflineUntilMs !== null) return;
      if (dispatch({ type: 'P2P_EXHAUSTED', at: now() })) {
        reportFailure('ICE_FAILED');
        deps.onEvent({ type: 'failed', reason: 'ICE_FAILED' });
      }
      return;
    }

    const isIce = attempt <= iceAttempts;
    lastVia = isIce ? 'ice-restart' : 'rebuild';
    const delay = isIce ? policy.p2p.iceRestartDelaysMs[attempt - 1] ?? 0 : 0;

    p2pDelayTimer = clock.setTimeout(() => {
      p2pDelayTimer = null;
      const task = isIce ? deps.p2p.restartIce() : deps.p2p.rebuild(true);
      task.catch(() => {
        /* 具体失败由步骤超时兜底，避免未捕获 rejection */
      });
      armStepTimeout();
    }, delay);
  }

  /** 落子时发现 DC 未开：只做一次 P2P 探测（R9） */
  function probeP2pOnce(): void {
    if (p2pProbeStarted) return;
    p2pProbeStarted = true;
    lastVia = 'ice-restart';
    const task = deps.p2p.restartIce();
    task.catch(() => {
      /* 由步骤超时兜底 */
    });
    armStepTimeout();
  }

  function onDcOpen(): void {
    if (disposed) return;
    dcNotOpenReported = false;
    p2pProbeStarted = false;
    clearP2pTimers();
    clearPeerWait();

    const prev = snap.state;

    if (prev === 'P2P_RECOVERING') {
      // DC 重开但棋谱未对齐：房主发起 sync，加入方等 sync
      if (role === 'host') {
        sendSync();
        return;
      }
      /**
       * 加入方兜底（缺陷 3）：对端可能是旧客户端（永远不发 `sync`），
       * 也可能 sync 丢包。超时按「已恢复但未确认」降级放行（architecture §10.3），
       * 绝不永久卡在「网络波动，正在恢复直连…」。
       */
      clearSyncTimer();
      syncTimer = clock.setTimeout(() => {
        syncTimer = null;
        if (disposed || snap.state !== 'P2P_RECOVERING') return;
        finishRestore(0);
      }, policy.p2p.peerOnlineWaitMs);
      return;
    }

    if (prev !== 'NEGOTIATING') return;

    dispatch({ type: 'DC_OPEN', at: now() });
    if (snap.state !== 'CONNECTED') return;

    if (restorePending) {
      lastVia = 'ws-only';
      if (role === 'host') sendSync();
      else finishRestore(0);
      return;
    }

    deps.onEvent({ type: 'connected' });
    // 同房号重建 / 续局场景：房主需要把已有棋谱推给对手
    if (role === 'host' && deps.getLocalMoves().length > 0) sendSync();
    scheduleIncidentSettle();
  }

  /* ==========================================================================
   * 恢复完成与棋谱对账
   * ======================================================================== */

  /** resume 成功（或降级 join 成功）后的统一入口 */
  function onSessionRestored(): void {
    clearRetryTimer();
    if (!hasPeer) {
      restorePending = false;
      patch({ attempt: 0, reason: null });
      return;
    }
    if (!dispatch({ type: 'PEER_PRESENT', at: now() })) return;

    if (deps.p2p.isDcOpen()) {
      // WS 断开但 P2P 仍活：ws-only 恢复（无需 ICE restart）
      dispatch({ type: 'DC_OPEN', at: now() });
      lastVia = 'ws-only';
      if (role === 'host') sendSync();
      else finishRestore(0);
      return;
    }

    if (!dispatch({ type: 'P2P_LOST', at: now(), reason: 'ICE_FAILED' })) return;

    if (role !== 'host') return; // 加入方只等 offer

    if (snap.serverCompat === 'v1') {
      // 旧服务端已把座位清掉：必须全量重建（新 PC + 新 offer）
      lastVia = 'rebuild';
      const task = deps.p2p.rebuild(true);
      task.catch(() => {
        /* 由步骤超时兜底 */
      });
      armStepTimeout();
      return;
    }

    // 房主必须等对手 peer-online 后再发 offer（R11），最多等 peerOnlineWaitMs
    clearPeerWait();
    peerWaitTimer = clock.setTimeout(() => {
      peerWaitTimer = null;
      if (disposed || snap.state !== 'P2P_RECOVERING') return;
      runP2pStep();
    }, policy.p2p.peerOnlineWaitMs);
  }

  /** 房主：把本地棋谱作为权威版本推给加入方 */
  function sendSync(): void {
    if (restorePending && !policy.syncOnRestore) {
      finishRestore(0);
      return;
    }

    syncRev += 1;
    awaitingAckRev = syncRev;
    const moves: Move[] = deps.getLocalMoves().map((m) => ({ x: m.x, y: m.y, c: m.c }));
    const sent = deps.p2p.send({ t: 'sync', moves, rev: syncRev });

    if (!sent) {
      if (restorePending) finishRestore(0);
      return;
    }

    clearSyncTimer();
    syncTimer = clock.setTimeout(() => {
      syncTimer = null;
      // 旧客户端不会 ack → 超时视为完成（§10.3），避免房主永久卡在 P2P_RECOVERING
      if (restorePending) finishRestore(0);
    }, policy.p2p.peerOnlineWaitMs);
  }

  function onSyncMessage(msg: SyncMsg): void {
    if (msg.ack) {
      if (awaitingAckRev !== null && msg.rev === awaitingAckRev) {
        clearSyncTimer();
        awaitingAckRev = null;
        if (restorePending) finishRestore(0);
      }
      return;
    }

    // 房主是权威方，不接受对端棋谱
    if (role === 'host') return;

    // 绝不信任对端数据：先逐手重放校验（K6-12）
    const replay = replayMoves(msg.moves);
    if (!replay.ok) {
      logger.log({ ev: 'conn.sync-reject', rev: msg.rev ?? 0, at: replay.at });
      return;
    }

    const plan = planSync({ role: 'guest', local: deps.getLocalMoves(), incoming: msg.moves });
    deps.onMovesReplaced(plan.adopt);
    deps.onEvent({ type: 'sync-applied', appended: plan.appended, mismatch: plan.mismatch });

    if (msg.rev !== undefined) {
      deps.p2p.send({ t: 'sync', moves: [], rev: msg.rev, ack: true });
    }

    if (snap.state === 'P2P_RECOVERING') finishRestore(plan.appended);
  }

  function onGameMessage(msg: GameMessage): void {
    if (msg.t === 'sync') {
      onSyncMessage(msg);
      return;
    }
    if (msg.t === 'ping') {
      // DC 心跳：立即回 pong（不落业务层）
      deps.p2p.send({ t: 'pong', ts: msg.ts });
      return;
    }
    if (msg.t === 'pong') return;
    deps.onGameMessage(msg);
  }

  /** 恢复完成：P2P_RECOVERING → CONNECTED，并打 1 条 conn.restore */
  function finishRestore(movesSynced: number): void {
    clearSyncTimer();
    clearP2pTimers();
    clearPeerWait();

    if (snap.state === 'P2P_RECOVERING') {
      dispatch({ type: 'SYNCED', at: now(), movesSynced });
    }
    if (snap.state !== 'CONNECTED') return;

    restorePending = false;
    awaitingAckRev = null;
    logger.log({
      ev: 'conn.restore',
      attempt: snap.attempt,
      totalMs: Math.max(0, now() - incidentStartMs),
      via: lastVia,
      movesSynced,
    });
    deps.onEvent({ type: 'restored', via: lastVia, movesSynced });
    scheduleIncidentSettle();
  }

  /** 回到 CONNECTED 稳定 incidentSettleMs 后才关闭 incident（避免抖动反复计次） */
  function scheduleIncidentSettle(): void {
    clearIncidentTimer();
    incidentTimer = clock.setTimeout(() => {
      incidentTimer = null;
      if (disposed) return;
      if (snap.state !== 'CONNECTED') return;
      dispatch({ type: 'INCIDENT_CLOSED', at: now() });
      failedReported = false;
    }, policy.incidentSettleMs);
  }

  /* ==========================================================================
   * 对外动作
   * ======================================================================== */

  function createRoom(code: string, name?: string): void {
    if (name !== undefined) myName = name;
    const target = code.toUpperCase();
    // 已有会话且 socket 可用：先问服务端，确认后才提交（缺陷 2）
    if (hasLiveSession() && deps.signal.readyState === 'open') {
      beginSwitch('create', target, myName);
      return;
    }
    startSession('create', target, myName);
  }

  function joinRoom(code: string, name: string): void {
    myName = name;
    const target = code.toUpperCase();
    if (hasLiveSession() && deps.signal.readyState === 'open') {
      beginSwitch('join', target, name);
      return;
    }
    startSession('join', target, name);
  }

  function retryNow(): void {
    if (disposed) return;
    if (snap.state !== 'RECONNECTING' && snap.state !== 'FAILED') return;
    clearAllTimers();
    if (!dispatch({ type: 'RETRY_NOW', at: now() })) return;
    prepareReconnect();
    incidentStartMs = now();
    failedReported = false;
    openSignal();
  }

  function leave(): void {
    clearAllTimers();
    if (!disposed) {
      deps.signal.send({ t: 'leave' });
      deps.signal.close(1000);
      deps.p2p.close();
      dispatch({ type: 'LEAVE', at: now() });
    }
    pendingIntent = 'none';
    restorePending = false;
    peerId = null;
    token = null;
    hasPeer = false;
    room = null;
  }

  function setPageVisible(visible: boolean): void {
    if (disposed) return;
    if (visible) {
      dispatch({ type: 'RESUME', at: now() });
      // 回前台立即探活 + 立即重试，不等剩余退避（R10）
      if (snap.state === 'RECONNECTING') retryNow();
      return;
    }
    dispatch({ type: 'PAUSE', at: now() });
    clearRetryTimer(); // 隐藏期间不烧电；nextRetryAtMs 保留供 UI 恢复
  }

  function notifyLocalMove(): void {
    if (disposed) return;
    if (deps.p2p.isDcOpen()) return;
    if (dcNotOpenReported) return;
    dcNotOpenReported = true;
    logger.log({
      ev: 'conn.fail',
      reason: 'DC_NOT_OPEN',
      attempt: snap.attempt,
      totalMs: Math.max(0, now() - incidentStartMs),
      online: deps.isOnline(),
      visibility: snap.paused ? 'hidden' : 'visible',
    });
    if (snap.state !== 'CONNECTED') return;
    if (!dispatch({ type: 'P2P_LOST', at: now(), reason: 'DC_NOT_OPEN' })) return;
    beginP2pRestore();
    if (role === 'host') probeP2pOnce();
  }

  function notifyPeerGone(): void {
    if (disposed) return;
    clearAllTimers();
    if (dispatch({ type: 'PEER_GONE', at: now() })) {
      deps.onEvent({ type: 'peer-gone' });
    }
  }

  function getStatus(): ConnectionStatus {
    return deriveStatus(snap, policy, now());
  }

  function dispose(): void {
    clearAllTimers();
    deps.signal.close(1000);
    deps.p2p.close();
    disposed = true;
  }

  // 单一事件订阅（不做多播，避免监听器泄漏）
  deps.signal.onEvent(handleSignalEvent);
  deps.p2p.onEvent(handleP2pEvent);
  publish();

  return {
    createRoom,
    joinRoom,
    retryNow,
    leave,
    setPageVisible,
    notifyLocalMove,
    notifyPeerGone,
    getStatus,
    dispose,
  };
}
