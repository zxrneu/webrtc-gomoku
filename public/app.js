'use strict';
/* global GameCore */
/*
 * WebRTC 五子棋 - 前端主逻辑
 * 连接方式：
 *  1) 房间联机：WebSocket 信令服务器按房间中转 offer/answer/ice，之后走 DataChannel 直连；
 *  2) 手动信令：无需服务器，双方互相复制粘贴连接码（SDP 经 deflate 压缩）。
 * 对局协议（DataChannel，JSON）：
 *  hello / move / chat / undo-req / undo-ok / undo-no / restart-req / restart-ok / restart-no / bye
 */
(function () {
  const Core = window.GameCore;
  const SIZE = Core.SIZE;
  const BLACK = Core.BLACK;
  const WHITE = Core.WHITE;
  const COLS = 'ABCDEFGHIJKLMNO';

  const CELL = 36;
  const PAD = 28;
  const CANVAS = (SIZE - 1) * CELL + PAD * 2; // 560

  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  const $ = (id) => document.getElementById(id);

  const dom = {
    canvas: $('board'),
    badge: $('conn-badge'),
    badgeText: $('conn-text'),
    overlay: $('board-overlay'),
    overlayText: $('overlay-text'),
    banner: $('result-banner'),
    resultText: $('result-text'),
    rematchBtn: $('rematch-btn'),
    undoBtn: $('undo-btn'),
    restartBtn: $('restart-btn'),
    soundBtn: $('sound-btn'),
    turnHint: $('turn-hint'),
    nameInput: $('name-input'),
    createBtn: $('create-room-btn'),
    roomInput: $('room-input'),
    joinBtn: $('join-room-btn'),
    roomInfo: $('room-info'),
    roomCodeText: $('room-code-text'),
    copyLinkBtn: $('copy-link-btn'),
    roomStatus: $('room-status'),
    fileTip: $('file-tip'),
    manualHostBtn: $('manual-host-btn'),
    manualGuestBtn: $('manual-guest-btn'),
    manualHostFinishBtn: $('manual-host-finish-btn'),
    manualInGuest: $('manual-in-guest'),
    manualInHost: $('manual-in-host'),
    manualOut: $('manual-out'),
    manualOutWrap: $('manual-out-wrap'),
    manualCopyBtn: $('manual-copy-btn'),
    blackName: $('black-name'),
    whiteName: $('white-name'),
    blackTag: $('black-tag'),
    whiteTag: $('white-tag'),
    playerBlack: $('player-black'),
    playerWhite: $('player-white'),
    moveCount: $('move-count'),
    lastMove: $('last-move'),
    gameState: $('game-state'),
    chatList: $('chat-list'),
    chatInput: $('chat-input'),
    chatSend: $('chat-send-btn'),
    modalMask: $('modal-mask'),
    modalTitle: $('modal-title'),
    modalText: $('modal-text'),
    modalOk: $('modal-ok'),
    modalNo: $('modal-no'),
    toast: $('toast'),
  };

  /* ---------------- 状态 ---------------- */
  const S = {
    ws: null,
    wsQueue: [],
    pc: null,
    dc: null,
    room: null,
    role: null, // 'host' | 'guest'
    myColor: 0,
    game: Core.create(),
    connected: false,
    manual: false,
    myName: '',
    peerName: '',
    sound: localStorage.getItem('gomoku-sound') !== 'off',
    pendingIce: [],
    hover: null,
    modalOk: null,
    modalNo: null,
  };

  const other = (c) => (c === BLACK ? WHITE : BLACK);
  const moveLabel = (m) => COLS[m.x] + (m.y + 1);
  const myTurn = () => S.connected && !S.game.over && Core.currentColor(S.game) === S.myColor;

  /* ---------------- 提示 ---------------- */
  let toastTimer = null;
  function toast(text) {
    dom.toast.textContent = text;
    dom.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), 2800);
  }

  function sysMsg(text) { addChat('', text, 'sys'); }

  function addChat(who, text, cls) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = cls === 'sys' ? text : (who ? who + '：' : '') + text;
    dom.chatList.appendChild(div);
    dom.chatList.scrollTop = dom.chatList.scrollHeight;
  }

  function setBadge(state, text) {
    dom.badge.classList.remove('offline', 'signaling', 'online');
    dom.badge.classList.add(state);
    dom.badgeText.textContent = text;
  }

  /* ---------------- 音效 ---------------- */
  let actx = null;
  function tone(freq, dur, delay, vol, type) {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime + (delay || 0);
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(vol || 0.08, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t0);
      o.stop(t0 + dur);
    } catch (e) { /* 忽略音频错误 */ }
  }
  const sndMove = (c) => tone(c === BLACK ? 420 : 560, 0.07, 0, 0.08);
  const sndWin = () => { tone(523, 0.12, 0, 0.1); tone(659, 0.12, 0.12, 0.1); tone(784, 0.22, 0.24, 0.1); };
  const sndLose = () => { tone(392, 0.16, 0, 0.08); tone(311, 0.26, 0.16, 0.08); };

  function refreshSoundBtn() {
    dom.soundBtn.textContent = S.sound ? '音效：开' : '音效：关';
    dom.soundBtn.setAttribute('aria-pressed', String(S.sound));
  }

  /* ---------------- 棋盘渲染 ---------------- */
  const ctx = dom.canvas.getContext('2d');

  function setupCanvas() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    dom.canvas.width = CANVAS * dpr;
    dom.canvas.height = CANVAS * dpr;
    dom.canvas.style.width = CANVAS + 'px';
    dom.canvas.style.height = CANVAS + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawStone(gx, gy, color, alpha) {
    const cx = PAD + gx * CELL;
    const cy = PAD + gy * CELL;
    const r = CELL * 0.44;
    ctx.save();
    if (alpha) ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    const rg = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
    if (color === BLACK) {
      rg.addColorStop(0, '#6a6a6a');
      rg.addColorStop(1, '#0c0c0c');
    } else {
      rg.addColorStop(0, '#ffffff');
      rg.addColorStop(1, '#c9c9c9');
    }
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, CANVAS, CANVAS);

    // 木纹底
    const bg = ctx.createLinearGradient(0, 0, CANVAS, CANVAS);
    bg.addColorStop(0, '#f3dcb2');
    bg.addColorStop(1, '#e7bd7f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS, CANVAS);

    // 网格
    const end = PAD + (SIZE - 1) * CELL;
    ctx.strokeStyle = 'rgba(120, 80, 35, 0.85)';
    ctx.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      const p = PAD + i * CELL;
      ctx.beginPath(); ctx.moveTo(PAD, p); ctx.lineTo(end, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, PAD); ctx.lineTo(p, end); ctx.stroke();
    }
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, PAD, end - PAD, end - PAD);

    // 星位
    ctx.fillStyle = 'rgba(120, 80, 35, 0.9)';
    for (const [sx, sy] of [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]) {
      ctx.beginPath();
      ctx.arc(PAD + sx * CELL, PAD + sy * CELL, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 坐标
    ctx.fillStyle = 'rgba(120, 80, 35, 0.55)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < SIZE; i++) {
      ctx.fillText(COLS[i], PAD + i * CELL, PAD - 14);
      ctx.fillText(String(i + 1), PAD - 16, PAD + i * CELL);
    }

    // 棋子
    for (const m of S.game.moves) drawStone(m.x, m.y, m.c);

    // 最后一手标记
    const last = S.game.moves[S.game.moves.length - 1];
    if (last) {
      ctx.strokeStyle = 'rgba(220, 40, 40, 0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(PAD + last.x * CELL, PAD + last.y * CELL, CELL * 0.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 悬停预览
    if (S.hover && myTurn() && S.game.board[S.hover.y][S.hover.x] === 0) {
      drawStone(S.hover.x, S.hover.y, S.myColor, 0.35);
    }

    // 胜利连线
    if (S.game.winLine) {
      const a = S.game.winLine[0];
      const b = S.game.winLine[S.game.winLine.length - 1];
      ctx.save();
      ctx.strokeStyle = 'rgba(208, 69, 59, 0.9)';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(208, 69, 59, 0.5)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(PAD + a[0] * CELL, PAD + a[1] * CELL);
      ctx.lineTo(PAD + b[0] * CELL, PAD + b[1] * CELL);
      ctx.stroke();
      ctx.restore();
    }
  }

  function cellFromEvent(e) {
    const rect = dom.canvas.getBoundingClientRect();
    if (!rect.width) return null;
    const lx = (e.clientX - rect.left) * (CANVAS / rect.width);
    const ly = (e.clientY - rect.top) * (CANVAS / rect.height);
    const x = Math.round((lx - PAD) / CELL);
    const y = Math.round((ly - PAD) / CELL);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null;
    return { x, y };
  }

  /* ---------------- HUD ---------------- */
  function updateHUD() {
    const cur = Core.currentColor(S.game);
    dom.moveCount.textContent = String(S.game.moves.length);
    const last = S.game.moves[S.game.moves.length - 1];
    dom.lastMove.textContent = last ? moveLabel(last) : '-';
    dom.gameState.textContent = S.game.over ? '已结束' : (S.connected ? '对战中' : '未开始');

    if (!S.connected) dom.turnHint.textContent = '等待连接…';
    else if (S.game.over) dom.turnHint.textContent = '对局结束';
    else if (myTurn()) dom.turnHint.textContent = cur === BLACK ? '轮到你了（黑）' : '轮到你了（白）';
    else dom.turnHint.textContent = '等待对方落子…';

    dom.undoBtn.disabled = !S.connected || S.game.over || S.game.moves.length === 0;
    dom.restartBtn.disabled = !S.connected;
    dom.chatInput.disabled = !S.connected;
    dom.chatSend.disabled = !S.connected;

    dom.playerBlack.classList.toggle('active', S.connected && !S.game.over && cur === BLACK);
    dom.playerWhite.classList.toggle('active', S.connected && !S.game.over && cur === WHITE);

    if (S.connected) {
      dom.blackName.textContent = S.myColor === BLACK ? S.myName + '（你）' : (S.peerName || '黑方');
      dom.whiteName.textContent = S.myColor === WHITE ? S.myName + '（你）' : (S.peerName || '白方');
      dom.blackTag.textContent = S.myColor === BLACK ? '邀请方 · 你' : '对手';
      dom.whiteTag.textContent = S.myColor === WHITE ? '加入方 · 你' : '对手';
    }
  }

  /* ---------------- 对局动作 ---------------- */
  function resetGame() {
    S.game = Core.create();
    dom.banner.classList.add('hidden');
    render();
    updateHUD();
  }

  function showResult(kind, winnerColor) {
    dom.banner.classList.remove('hidden', 'win', 'lose', 'draw');
    dom.banner.classList.add(kind);
    if (kind === 'win') dom.resultText.textContent = '你赢了（' + (winnerColor === BLACK ? '黑' : '白') + '方五连）';
    else if (kind === 'lose') dom.resultText.textContent = '你输了，再来一局？';
    else dom.resultText.textContent = '平局！';
    updateHUD();
  }

  function afterMove(r) {
    render();
    updateHUD();
    const last = S.game.moves[S.game.moves.length - 1];
    if (last) sndMove(last.c);
    if (r.event === 'win') {
      const win = r.winner === S.myColor;
      showResult(win ? 'win' : 'lose', r.winner);
      if (win) sndWin(); else sndLose();
      sysMsg(win ? '你赢了！' : '你输了，再接再厉');
    } else if (r.event === 'draw') {
      showResult('draw');
      sysMsg('棋盘已满，平局');
    }
  }

  function playLocal(x, y) {
    const r = Core.applyMove(S.game, x, y, S.myColor);
    if (!r.ok) return;
    dcSend({ t: 'move', x, y });
    afterMove(r);
  }

  dom.canvas.addEventListener('click', (e) => {
    if (!S.connected) return;
    if (!myTurn()) {
      toast(S.game.over ? '对局已结束，可重新开始' : '还没到你的回合');
      return;
    }
    const c = cellFromEvent(e);
    if (!c || S.game.board[c.y][c.x] !== 0) return;
    playLocal(c.x, c.y);
  });

  dom.canvas.addEventListener('mousemove', (e) => {
    const c = cellFromEvent(e);
    const same = (!c && !S.hover) || (c && S.hover && c.x === S.hover.x && c.y === S.hover.y);
    S.hover = c;
    if (!same) render();
  });
  dom.canvas.addEventListener('mouseleave', () => { S.hover = null; render(); });

  /* ---------------- 悔棋 / 重开 ---------------- */
  dom.undoBtn.onclick = () => {
    if (!S.connected || S.game.over || S.game.moves.length === 0) return;
    dcSend({ t: 'undo-req' });
    sysMsg('已发送悔棋请求，等待对方回应…');
  };

  function replyUndo(ok) {
    dcSend({ t: ok ? 'undo-ok' : 'undo-no' });
    if (ok) {
      const m = Core.undo(S.game);
      if (m) {
        render();
        updateHUD();
        sysMsg('已悔棋一步');
      }
    }
  }

  dom.restartBtn.onclick = () => {
    if (!S.connected) return;
    dcSend({ t: 'restart-req' });
    sysMsg('已发送重新开始请求，等待对方回应…');
  };
  dom.rematchBtn.onclick = () => {
    if (!S.connected) return;
    dcSend({ t: 'restart-req' });
  };

  function replyRestart(ok) {
    dcSend({ t: ok ? 'restart-ok' : 'restart-no' });
    if (ok) resetGame();
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal(title, text, onOk, onNo) {
    dom.modalTitle.textContent = title;
    dom.modalText.textContent = text;
    S.modalOk = onOk;
    S.modalNo = onNo;
    dom.modalMask.classList.remove('hidden');
  }
  function closeModal() {
    dom.modalMask.classList.add('hidden');
    S.modalOk = null;
    S.modalNo = null;
  }
  dom.modalOk.onclick = () => { const f = S.modalOk; closeModal(); if (f) f(); };
  dom.modalNo.onclick = () => { const f = S.modalNo; closeModal(); if (f) f(); };

  /* ---------------- 聊天 ---------------- */
  function sendChat() {
    const text = dom.chatInput.value.trim();
    if (!text || !S.connected) return;
    dcSend({ t: 'chat', text: text.slice(0, 200) });
    addChat(S.myName, text, 'mine');
    dom.chatInput.value = '';
  }
  dom.chatSend.onclick = sendChat;
  dom.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  dom.soundBtn.onclick = () => {
    S.sound = !S.sound;
    localStorage.setItem('gomoku-sound', S.sound ? 'on' : 'off');
    refreshSoundBtn();
  };

  /* ---------------- 信令（房间联机） ---------------- */
  function signalSend(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
    else S.wsQueue.push(obj);
  }

  function ensureSignaling() {
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
    setBadge('offline', '信令连接中…');
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/signal');
    S.ws = ws;
    ws.onopen = () => {
      setBadge('signaling', '信令已连接');
      const queue = S.wsQueue;
      S.wsQueue = [];
      queue.forEach(signalSend);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onSignal(m);
    };
    ws.onclose = () => {
      setBadge('offline', '信令已断开');
      sysMsg('信令服务器连接已断开，请刷新页面重试');
    };
    ws.onerror = () => setBadge('offline', '信令连接失败');
  }

  function readName() {
    S.myName = dom.nameInput.value.trim().slice(0, 12);
    if (S.myName) localStorage.setItem('gomoku-name', S.myName);
    return S.myName;
  }

  function genRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  dom.createBtn.onclick = () => {
    if (!readName()) return toast('先输入昵称');
    ensureSignaling();
    signalSend({ t: 'create', room: genRoomCode(), name: S.myName });
  };

  dom.joinBtn.onclick = () => {
    if (!readName()) return toast('先输入昵称');
    const code = dom.roomInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return toast('房间号为 4 位字母或数字');
    ensureSignaling();
    signalSend({ t: 'join', room: code, name: S.myName });
  };

  dom.copyLinkBtn.onclick = async () => {
    if (!S.room) return;
    const link = location.origin + location.pathname + '?room=' + S.room;
    try {
      await navigator.clipboard.writeText(link);
      toast('邀请链接已复制，发给朋友即可');
    } catch (e) {
      toast('复制失败，请手动复制：' + link);
    }
  };

  function onSignal(m) {
    switch (m.t) {
      case 'created':
        S.room = m.room;
        S.role = 'host';
        S.myColor = BLACK;
        dom.roomInfo.classList.remove('hidden');
        dom.roomCodeText.textContent = m.room;
        dom.roomStatus.textContent = '等待对手加入…';
        setBadge('signaling', '等待对手加入');
        dom.overlayText.textContent = '房间号 ' + m.room + '，把邀请链接发给朋友，等待对手加入…';
        break;
      case 'joined':
        S.room = m.room;
        S.role = 'guest';
        S.myColor = WHITE;
        dom.overlayText.textContent = '已加入房间，正在建立 P2P 连接…';
        setBadge('signaling', '连接建立中');
        break;
      case 'peer-joined':
        sysMsg((m.name ? m.name + ' ' : '') + '加入了房间');
        dom.roomStatus.textContent = '对手已加入，正在建立 P2P 连接…';
        setBadge('signaling', '连接建立中');
        startOffer();
        break;
      case 'signal':
        handleSignal(m.data).catch((e) => toast('信令处理失败：' + e.message));
        break;
      case 'peer-left':
        sysMsg('对手离开了房间');
        onPeerLeft();
        break;
      case 'error':
        toast(m.message || '出错了');
        dom.roomStatus.textContent = m.message || '';
        break;
      default:
        break;
    }
  }

  /* ---------------- WebRTC ---------------- */
  function createPeer() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (e) => {
      // 手动信令模式下候选已包含在 SDP 里，不需要单独发送
      if (e.candidate && !S.manual) {
        signalSend({ t: 'signal', room: S.room, data: { kind: 'ice', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate } });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        toast('P2P 连接失败：网络环境可能限制直连（对称型 NAT 需要 TURN 中转）');
        onPeerLeft();
      }
    };
    pc.ondatachannel = (e) => bindDataChannel(e.channel);
    S.pc = pc;
    return pc;
  }

  async function startOffer() {
    try {
      const pc = createPeer();
      const dc = pc.createDataChannel('gomoku', { ordered: true });
      bindDataChannel(dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signalSend({ t: 'signal', room: S.room, data: { kind: 'offer', sdp: pc.localDescription } });
      dom.overlayText.textContent = '已发出邀请，正在等待对方应答…';
    } catch (e) {
      toast('创建连接失败：' + e.message);
    }
  }

  async function flushIce(pc) {
    while (S.pendingIce.length) {
      const c = S.pendingIce.shift();
      try { await pc.addIceCandidate(c); } catch (e) { /* 忽略过期候选 */ }
    }
  }

  async function handleSignal(data) {
    if (!data || !data.kind) return;
    if (data.kind === 'offer') {
      if (S.pc) return; // 已在对局中，忽略重复 offer
      const pc = createPeer();
      await pc.setRemoteDescription(data.sdp);
      await flushIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signalSend({ t: 'signal', room: S.room, data: { kind: 'answer', sdp: pc.localDescription } });
    } else if (data.kind === 'answer') {
      if (!S.pc || S.pc.signalingState !== 'have-local-offer') return;
      await S.pc.setRemoteDescription(data.sdp);
      await flushIce(S.pc);
    } else if (data.kind === 'ice') {
      if (S.pc && S.pc.remoteDescription && S.pc.remoteDescription.type) {
        try { await S.pc.addIceCandidate(data.candidate); } catch (e) { /* 忽略 */ }
      } else {
        S.pendingIce.push(data.candidate);
      }
    }
  }

  function bindDataChannel(dc) {
    S.dc = dc;
    dc.onopen = () => {
      S.connected = true;
      resetGame();
      setBadge('online', 'P2P 已连接');
      dom.overlay.classList.add('hidden');
      dcSend({ t: 'hello', name: S.myName || '玩家' });
      sysMsg('P2P 连接已建立，对局开始！黑方先行');
      updateHUD();
    };
    dc.onclose = () => onPeerLeft();
    dc.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onGameMessage(m);
    };
  }

  function dcSend(obj) {
    if (S.dc && S.dc.readyState === 'open') S.dc.send(JSON.stringify(obj));
  }

  function onPeerLeft() {
    S.connected = false;
    setBadge('offline', '对手已离开');
    dom.banner.classList.add('hidden');
    dom.overlay.classList.remove('hidden');
    dom.overlayText.textContent = '对手已离开。在右侧重新创建或加入房间，即可开始新对局。';
    updateHUD();
  }

  /* ---------------- 对局消息 ---------------- */
  function onGameMessage(m) {
    switch (m.t) {
      case 'hello':
        S.peerName = String(m.name || '对手').slice(0, 12);
        sysMsg(S.peerName + ' 已就位');
        updateHUD();
        break;
      case 'move': {
        const r = Core.applyMove(S.game, m.x, m.y, other(S.myColor));
        if (!r.ok) return;
        afterMove(r);
        break;
      }
      case 'chat':
        if (typeof m.text === 'string') addChat(S.peerName || '对手', m.text.slice(0, 200), 'theirs');
        break;
      case 'undo-req':
        openModal('悔棋请求', (S.peerName || '对手') + ' 请求悔棋一步', () => replyUndo(true), () => replyUndo(false));
        break;
      case 'undo-ok': {
        const m2 = Core.undo(S.game);
        if (m2) {
          render();
          updateHUD();
          sysMsg('对方同意了悔棋');
        }
        break;
      }
      case 'undo-no':
        sysMsg('对方拒绝了悔棋');
        break;
      case 'restart-req':
        openModal('重新开始', (S.peerName || '对手') + ' 请求开始新的一局', () => replyRestart(true), () => replyRestart(false));
        break;
      case 'restart-ok':
        resetGame();
        sysMsg('新的一局开始了，黑方先行');
        break;
      case 'restart-no':
        sysMsg('对方拒绝了重新开始');
        break;
      case 'bye':
        onPeerLeft();
        break;
      default:
        break;
    }
  }

  /* ---------------- 手动信令模式 ---------------- */
  function bytesToB64url(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBytes(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function pack(obj) {
    const json = JSON.stringify(obj);
    if (typeof CompressionStream === 'undefined') return json;
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      return 'Z' + bytesToB64url(buf);
    } catch (e) {
      return json;
    }
  }

  async function unpack(str) {
    if (str.charAt(0) === 'Z') {
      try {
        const stream = new Blob([b64urlToBytes(str.slice(1))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return JSON.parse(await new Response(stream).text());
      } catch (e) { /* 回退到原文 */ }
    }
    return JSON.parse(str);
  }

  function showManualOut(code) {
    dom.manualOutWrap.classList.remove('hidden');
    dom.manualOut.value = code;
  }

  function waitIce(pc, timeout) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, timeout || 4000);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  dom.manualHostBtn.onclick = async () => {
    S.manual = true;
    S.role = 'host';
    S.myColor = BLACK;
    readName();
    try {
      const pc = createPeer();
      const dc = pc.createDataChannel('gomoku', { ordered: true });
      bindDataChannel(dc);
      await pc.setLocalDescription(await pc.createOffer());
      dom.overlayText.textContent = '正在收集网络候选地址，请稍候…';
      await waitIce(pc);
      showManualOut(await pack({ type: 'offer', sdp: pc.localDescription }));
      toast('邀请码已生成，复制发给对方');
    } catch (e) {
      toast('生成邀请码失败：' + e.message);
    }
  };

  dom.manualGuestBtn.onclick = async () => {
    const raw = dom.manualInGuest.value.trim();
    if (!raw) return toast('先粘贴收到的邀请码');
    S.manual = true;
    S.role = 'guest';
    S.myColor = WHITE;
    readName();
    try {
      const data = await unpack(raw);
      if (!data || data.type !== 'offer') return toast('邀请码无效');
      const pc = createPeer();
      await pc.setRemoteDescription(data.sdp);
      await flushIce(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIce(pc);
      showManualOut(await pack({ type: 'answer', sdp: pc.localDescription }));
      toast('应答码已生成，复制发回给邀请方');
    } catch (e) {
      toast('生成应答码失败：' + e.message);
    }
  };

  dom.manualHostFinishBtn.onclick = async () => {
    const raw = dom.manualInHost.value.trim();
    if (!raw) return toast('先粘贴收到的应答码');
    try {
      const data = await unpack(raw);
      if (!data || data.type !== 'answer') return toast('应答码无效');
      if (!S.pc) return toast('请先完成第 ① 步生成邀请码');
      await S.pc.setRemoteDescription(data.sdp);
      await flushIce(S.pc);
      dom.overlayText.textContent = '正在连接…';
    } catch (e) {
      toast('连接失败：' + e.message);
    }
  };

  dom.manualCopyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(dom.manualOut.value);
      toast('已复制到剪贴板');
    } catch (e) {
      dom.manualOut.select();
      document.execCommand('copy');
      toast('已复制到剪贴板');
    }
  };

  /* ---------------- 标签页 ---------------- */
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $('tab-room').classList.toggle('hidden', btn.dataset.tab !== 'room');
      $('tab-manual').classList.toggle('hidden', btn.dataset.tab !== 'manual');
    };
  });

  /* ---------------- 初始化 ---------------- */
  S.myName = localStorage.getItem('gomoku-name') || '';
  dom.nameInput.value = S.myName;

  // ?room=XXXX 预填加入房间
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();
  if (urlRoom) dom.roomInput.value = urlRoom;

  if (location.protocol === 'http:' || location.protocol === 'https:') {
    ensureSignaling();
  } else {
    dom.fileTip.style.display = 'block';
  }

  setupCanvas();
  refreshSoundBtn();
  render();
  updateHUD();
  sysMsg('创建或加入房间，开始 P2P 对局');

  // 测试/调试钩子（e2e.js 使用；deliver 用于在没有真实 P2P 连接时仿真对局消息）
  window.__gomoku = {
    get connected() { return S.connected; },
    get moves() { return S.game.moves.map((m) => ({ x: m.x, y: m.y, c: m.c })); },
    get over() { return S.game.over; },
    get myColor() { return S.myColor; },
    get peerName() { return S.peerName; },
    get room() { return S.room; },
    get pcState() { return S.pc ? S.pc.connectionState : 'none'; },
    get iceState() { return S.pc ? S.pc.iceConnectionState : 'none'; },
    get signalingState() { return S.pc ? S.pc.signalingState : 'none'; },
    get dcState() { return S.dc ? S.dc.readyState : 'none'; },
    get pendingIce() { return S.pendingIce.length; },
    // 测试专用：在无法建立真实 P2P 的环境中模拟“已连接”状态，以便走真实点击路径
    forceConnected: (v) => {
      S.connected = !!v;
      if (v) dom.overlay.classList.add('hidden');
      updateHUD();
    },
    deliver: (msg) => onGameMessage(msg),
  };
})();
