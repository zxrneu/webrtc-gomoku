'use strict';
/**
 * E2E 测试：两个浏览器上下文模拟双方玩家。
 *
 * 覆盖两层：
 *  A. 信令全链路（任何环境可跑）：建房/加入 → host 发 offer → guest 应答 → ICE 候选交换，
 *     通过页面内 RTCPeerConnection 状态断言验证（signalingState 迁移）。
 *  B. 对局协议（DataChannel 消息级）：落子同步、胜负判定、聊天、悔棋、重开。
 *     - 若环境允许真实 P2P 连通（用户本机正常运行），自动走真实点击对局；
 *     - 若 ICE 被环境阻断（如部分 CI/沙箱），自动降级为 deliver() 消息仿真，验证协议处理逻辑。
 *
 * 运行：先启动服务器（npm start），再 node test/e2e.js
 * 依赖：playwright（npm i playwright）与任一 Chromium 系浏览器
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const CELL = 36;
const PAD = 28;
const P2P_TIMEOUT = Number(process.env.P2P_TIMEOUT || 12000);
const REQUIRE_RELAY = process.env.REQUIRE_RELAY === '1';
const REQUIRE_P2P = REQUIRE_RELAY || process.env.REQUIRE_P2P === '1';

const failures = [];
function check(name, cond) {
  if (cond) console.log('  ok -', name);
  else { console.error('  FAIL -', name); failures.push(name); }
}

async function launchBrowser() {
  const candidates = [
    {},
    { executablePath: process.env.CHROME_PATH },
    { channel: 'chrome' },
  ].filter(Boolean);
  let lastErr = null;
  for (const opt of candidates) {
    try {
      return await chromium.launch({
        ...opt,
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
      });
    } catch (e) { lastErr = e; }
  }
  throw new Error('未找到可用浏览器: ' + (lastErr && lastErr.message));
}

(async () => {
  const browser = await launchBrowser();

  async function newPlayerPage(name) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`[${name} pageerror]`, e.message));
    await page.addInitScript((requireRelay) => {
      const send = RTCDataChannel.prototype.send;
      const create = RTCPeerConnection.prototype.createDataChannel;
      const NativePeer = RTCPeerConnection;
      window.__gameplayTest = { hold: false, holdColor: false, queue: [], channels: [], peers: [], protocolOnly: false };
      window.RTCPeerConnection = class extends NativePeer {
        constructor(config) {
          super(requireRelay ? { ...config, iceTransportPolicy: 'relay' } : config);
          window.__gameplayTest.peers.push(this);
        }
      };
      RTCDataChannel.prototype.send = function (raw) {
        const message = typeof raw === 'string' ? JSON.parse(raw) : null;
        if (window.__gameplayTest.protocolOnly) return;
        if ((window.__gameplayTest.hold && ['swap-ok', 'move'].includes(message?.t)) ||
            (window.__gameplayTest.holdColor && message?.t === 'color')) {
          window.__gameplayTest.queue.push({ channel: this, raw });
          return;
        }
        return send.call(this, raw);
      };
      RTCPeerConnection.prototype.createDataChannel = function (...args) {
        const channel = create.apply(this, args);
        window.__gameplayTest.channels.push(channel);
        return channel;
      };
      window.__gameplayTest.flush = () => {
        window.__gameplayTest.hold = false;
        window.__gameplayTest.holdColor = false;
        for (const { channel, raw } of window.__gameplayTest.queue.splice(0)) send.call(channel, raw);
      };
    }, REQUIRE_RELAY);
    await page.goto(BASE);
    if (await page.locator('#lobby-page').count()) await page.getByRole('button', { name: /返回棋盘/ }).click();
    if (await page.locator('[data-online-tab="room"]').count()) await page.locator('[data-online-tab="room"]').click();
    return page;
  }

  // 在 (gx,gy) 落下一子，并等待acting页手数达到 expected；失败自动重试并输出诊断
  async function clickCell(page, gx, gy, expected) {
    const board = page.locator('#board');
    await board.scrollIntoViewIfNeeded();
    const box = await board.boundingBox();
    const x = box.x + PAD + gx * CELL;
    const y = box.y + PAD + gy * CELL;
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.click(x, y);
      try {
        await page.waitForFunction((n) => window.__gomoku.moves.length === n, expected, { timeout: 2000 });
        return true;
      } catch (e) { /* 重试 */ }
    }
    const diag = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return {
        hit: el ? (el.id || el.tagName) : null,
        moves: window.__gomoku.moves.length,
        connected: window.__gomoku.connected,
        myColor: window.__gomoku.myColor,
        overlayHidden: document.getElementById('board-overlay').classList.contains('hidden'),
        bannerHidden: document.getElementById('result-banner').classList.contains('hidden'),
      };
    }, [x, y]);
    console.error('  clickCell 诊断:', JSON.stringify(diag));
    return false;
  }

  const state = (page) => page.evaluate(() => ({
    connected: window.__gomoku.connected,
    moves: window.__gomoku.moves.length,
    over: window.__gomoku.over,
    myColor: window.__gomoku.myColor,
    pcState: window.__gomoku.pcState,
    iceState: window.__gomoku.iceState,
    signalingState: window.__gomoku.signalingState,
    dcState: window.__gomoku.dcState,
    pendingIce: window.__gomoku.pendingIce,
  }));

  console.log('== 阶段一：房间联机信令链路 ==');
  const pageA = await newPlayerPage('A');
  const pageB = await newPlayerPage('B');
  await pageA.fill('#name-input', '小明');
  await pageB.fill('#name-input', '小红');

  await pageA.click('#create-room-btn');
  await pageA.waitForSelector('#room-info:not(.hidden)', { timeout: 5000 });
  const room = (await pageA.textContent('#room-code-text')).trim();
  check('房间创建成功，房号 ' + room, /^[A-Z0-9]{4}$/.test(room));

  await pageB.fill('#room-input', room);
  await pageB.click('#join-room-btn');

  // 等待 host 发出 offer（signalingState: have-local-offer；若对方已应答则为 stable）
  await pageA.waitForFunction(
    () => ['have-local-offer', 'stable'].includes(window.__gomoku.signalingState),
    null, { timeout: 10000 })
    .then(() => check('host 已生成 offer 并进入协商', true))
    .catch(() => check('host 已生成 offer 并进入协商', false));

  // 等待 guest 完成应答（signalingState 回到 stable）
  await pageB.waitForFunction(() => window.__gomoku.signalingState === 'stable', null, { timeout: 10000 })
    .then(() => check('guest 已接收 offer 并回送 answer', true))
    .catch(() => check('guest 已接收 offer 并回送 answer', false));

  // 尝试真实 P2P 连通
  let p2p = false;
  try {
    await pageA.waitForFunction(() => window.__gomoku.connected, null, { timeout: P2P_TIMEOUT });
    await pageB.waitForFunction(() => window.__gomoku.connected, null, { timeout: 5000 });
    p2p = true;
  } catch (e) { /* 环境阻断 ICE，降级 */ }

  if (p2p) {
    console.log('  (检测到真实 P2P 连通，执行真实对局)');
    check('P2P DataChannel 双向连通', true);
    check('A 是黑方(邀请方)', (await state(pageA)).myColor === 1);
    check('B 是白方(加入方)', (await state(pageB)).myColor === 2);
    if (REQUIRE_RELAY) {
      for (const [name, page] of [['A', pageA], ['B', pageB]]) {
        const candidateTypes = await page.evaluate(async () => {
          const peer = window.__gameplayTest.peers.find((pc) => pc.connectionState === 'connected');
          if (!peer) return [];
          const stats = await peer.getStats();
          const transport = [...stats.values()].find((report) => report.type === 'transport' && report.selectedCandidatePairId);
          const pair = transport && stats.get(transport.selectedCandidatePairId);
          return pair ? [stats.get(pair.localCandidateId)?.candidateType, stats.get(pair.remoteCandidateId)?.candidateType] : [];
        });
        check(`${name} 实际选择 TURN 中继候选对`, candidateTypes.length === 2 && candidateTypes.every((type) => type === 'relay'));
      }
    }
  } else {
    if (REQUIRE_P2P) {
      console.error('真实连接验收失败:', JSON.stringify({ A: await state(pageA), B: await state(pageB) }));
      await browser.close();
      throw new Error('必须建立真实 DataChannel，禁止降级为协议仿真');
    }
    console.log('  (本环境 ICE 被阻断，降级为对局协议仿真)');
    const sa = await state(pageA);
    const sb = await state(pageB);
    check('双方 SDP 协商完成（stable）', sa.signalingState === 'stable' && sb.signalingState === 'stable');
    // 信令链路已通：候选无残留积压
    check('ICE 候选无残留积压', sa.pendingIce === 0 && sb.pendingIce === 0);
    // 协议仿真也必须具备发送成功的通道；只修改 UI 状态会让换边发送守卫拒绝请求。
    for (const page of [pageA, pageB]) {
      await page.evaluate(() => {
        const test = window.__gameplayTest;
        test.protocolOnly = true;
        for (const peer of test.peers) {
          peer.onconnectionstatechange = null;
          peer.oniceconnectionstatechange = null;
          if (peer.ondatachannel) {
            const channel = { readyState: 'open', send() {}, close() {} };
            peer.ondatachannel({ channel });
            channel.onopen?.();
          }
        }
        for (const channel of test.channels) {
          Object.defineProperty(channel, 'readyState', { configurable: true, get: () => 'open' });
          channel.onopen?.();
        }
        window.__gomoku.forceConnected(true);
      });
    }
  }

  /* ---------- 对局测试 ---------- */
  // A(黑) 在第 0 行连五：A(7,7) B(5,5) A(0,0) B(6,6) A(1,0) B(8,8) A(2,0) B(9,9) A(3,0) B(10,10) A(4,0)
  const script = [
    ['A', 7, 7], ['B', 5, 5], ['A', 0, 0], ['B', 6, 6], ['A', 1, 0], ['B', 8, 8],
    ['A', 2, 0], ['B', 9, 9], ['A', 3, 0], ['B', 10, 10], ['A', 4, 0],
  ];
  console.log('== 阶段二：对局流程 ==');
  let expected = 0;
  for (const [who, x, y] of script) {
    expected++;
    const page = who === 'A' ? pageA : pageB;
    const peer = who === 'A' ? pageB : pageA;
    const okClick = await clickCell(page, x, y, expected);
    if (!okClick) check(`${who} 落子 (${x},${y})`, false);
    if (p2p) {
      await peer.waitForFunction((n) => window.__gomoku.moves.length === n, expected, { timeout: 8000 });
    } else {
      // 仿真：把落子消息直接投递给对端
      await peer.evaluate(([mx, my]) => window.__gomoku.deliver({ t: 'move', x: mx, y: my }), [x, y]);
    }
    await page.waitForFunction((n) => window.__gomoku.moves.length === n, expected, { timeout: 5000 });
  }
  check('11 手落子双方同步', (await state(pageA)).moves === 11 && (await state(pageB)).moves === 11);

  if (p2p) {
    check('双方判定对局结束', (await state(pageA)).over && (await state(pageB)).over);
  } else {
    // 仿真下最后一手已随循环投递给 B，双方应各自完成判定
    check('双方判定对局结束', (await state(pageA)).over && (await state(pageB)).over);
  }

  const bannerA = (await pageA.textContent('#result-text')).trim();
  const bannerB = (await pageB.textContent('#result-text')).trim();
  check(`A 看到胜利横幅（${bannerA}）`, bannerA.includes('你赢了'));
  check(`B 看到失败横幅（${bannerB}）`, bannerB.includes('你输了'));

  await pageA.screenshot({ path: 'test/e2e-win.png' });

  // 聊天
  await pageA.getByRole('tab', { name: /聊天/ }).click();
  await pageB.getByRole('tab', { name: /聊天/ }).click();
  if (p2p) {
    await pageA.fill('#chat-input', '你好呀');
    await pageA.click('#chat-send-btn');
    await pageB.waitForSelector('.msg.theirs:has-text("你好呀")', { timeout: 5000 });
  } else {
    await pageA.fill('#chat-input', '你好呀');
    await pageA.click('#chat-send-btn');
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'chat', text: '你好呀' }));
    await pageB.waitForSelector('.msg.theirs:has-text("你好呀")', { timeout: 5000 });
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'hello', name: '小明' }));
    await pageA.evaluate(() => window.__gomoku.deliver({ t: 'hello', name: '小红' }));
  }
  check('聊天消息送达对端', true);
  await pageA.getByRole('tab', { name: '对局', exact: true }).click();
  await pageB.getByRole('tab', { name: '对局', exact: true }).click();

  // 重新开始（请求-同意）
  await pageA.click('#restart-btn');
  if (p2p) {
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  } else {
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'restart-req' }));
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  }
  check('对端收到「重新开始」请求弹窗', true);
  await pageB.click('#modal-ok');
  if (!p2p) await pageA.evaluate(() => window.__gomoku.deliver({ t: 'restart-ok' }));
  await pageA.waitForFunction(() => window.__gomoku.moves.length === 0, null, { timeout: 5000 });
  await pageB.waitForFunction(() => window.__gomoku.moves.length === 0, null, { timeout: 5000 });
  check('双方同意后棋盘重置', true);

  // 回合制：非回合方落子被拒绝（重置后黑方 A 先行）
  await clickCell(pageB, 0, 0, 0);
  await pageA.waitForTimeout(400);
  check('非回合方落子被拒绝', (await state(pageA)).moves === 0);

  // 悔棋（请求-同意-回退）
  await clickCell(pageA, 7, 7, 1);
  if (p2p) {
    await pageB.waitForFunction(() => window.__gomoku.moves.length === 1, null, { timeout: 5000 });
  } else {
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'move', x: 7, y: 7 }));
  }
  await pageA.click('#undo-btn');
  if (p2p) {
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  } else {
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'undo-req' }));
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  }
  await pageB.click('#modal-ok');
  if (!p2p) await pageA.evaluate(() => window.__gomoku.deliver({ t: 'undo-ok' }));
  await pageA.waitForFunction(() => window.__gomoku.moves.length === 0, null, { timeout: 5000 });
  check('悔棋流程（请求-同意-回退）', true);

  /* ---------- 换边协商流程 (R1) ---------- */
  console.log('== 阶段二·新增：换边协商与手数显示 ==');
  // 1. A 发起换边申请，B 收到弹窗并同意
  const colorBeforeA = (await state(pageA)).myColor;
  const colorBeforeB = (await state(pageB)).myColor;
  await pageA.click('#toggle-color-btn');
  if (p2p) {
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  } else {
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'swap-req' }));
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  }
  check('对端收到「换边」申请确认弹窗', true);
  if (p2p) {
    await pageA.locator('#board').click({ position: { x: PAD + 7 * CELL, y: PAD + 7 * CELL } });
    check('换边协商期间申请方无法落子', (await state(pageA)).moves === 0);
    await pageA.click('#restart-btn');
    check('重开不会覆盖待确认的换边申请', (await pageB.textContent('#modal-title')).includes('换边'));
    await pageB.evaluate(() => { window.__gameplayTest.hold = true; });
  }
  await pageB.click('#modal-ok');
  if (!p2p) await pageA.evaluate(() => window.__gomoku.deliver({ t: 'swap-ok' }));
  if (p2p) {
    await pageB.waitForFunction(() => window.__gomoku.myColor === 1);
    await pageA.locator('#board').click({ position: { x: PAD + 7 * CELL, y: PAD + 7 * CELL } });
    check('换边同意消息尚未到达时申请方仍无法落子', (await state(pageA)).moves === 0);
    check('确认方换边后可以执黑落子', await clickCell(pageB, 8, 8, 1));
    await pageB.evaluate(() => window.__gameplayTest.flush());
    await pageA.waitForFunction(() => window.__gomoku.moves.length === 1);
    const movesA = await pageA.evaluate(() => window.__gomoku.moves);
    const movesB = await pageB.evaluate(() => window.__gomoku.moves);
    check('延迟换边确认和落子按顺序到达后双方棋盘一致', JSON.stringify(movesA) === JSON.stringify(movesB));
    await pageA.click('#restart-btn');
    await pageB.waitForSelector('#modal-mask:not(.hidden)');
    await pageB.click('#modal-ok');
    await pageA.waitForFunction(() => window.__gomoku.moves.length === 0);
  }
  await pageA.waitForFunction((c) => window.__gomoku.myColor !== c, colorBeforeA, { timeout: 5000 });
  await pageB.waitForFunction((c) => window.__gomoku.myColor !== c, colorBeforeB, { timeout: 5000 });
  const colorAfterA = (await state(pageA)).myColor;
  const colorAfterB = (await state(pageB)).myColor;
  check('换边同意后双方执子颜色互换（A 黑变白，B 白变黑）', colorAfterA === 2 && colorAfterB === 1);

  // 1.1 验证换边后轮次提示与身份标识实时同步
  const turnTextA = (await pageA.textContent('#turn-hint')).trim();
  const turnTextB = (await pageB.textContent('#turn-hint')).trim();
  check('换边后执白方A提示对方思考中', turnTextA.includes('对方思考中'));
  check('换边后执黑方B提示轮到你落子', turnTextB.includes('轮到你落子'));

  const roleA = (await pageA.textContent('#role-select-box')).trim();
  const roleB = (await pageB.textContent('#role-select-box')).trim();
  check('换边后A控制面板显示执白（后手）', roleA.includes('执白（后手）'));
  check('换边后B控制面板显示执黑（先行）', roleB.includes('执黑（先行）'));

  // 1.2 验证始终由执黑方首手落子：白方落子被拒，黑方可落子
  if (p2p) {
    // A (白) 尝试先手落子，应被拒绝
    const boardA = pageA.locator('#board');
    const boxA = await boardA.boundingBox();
    await pageA.mouse.click(boxA.x + PAD + 0 * CELL, boxA.y + PAD + 0 * CELL);
    await pageA.waitForTimeout(200);
    check('执白方A不可首手落子（非回合被拦截）', (await state(pageA)).moves === 0);

    // B (黑) 首手落子 (7,7)
    const bMoved = await clickCell(pageB, 7, 7, 1);
    check('执黑方B成功首手落子 (7,7)', bMoved);
    await pageA.waitForFunction(() => window.__gomoku.moves.length === 1, null, { timeout: 5000 });

    // A (白) 轮到后落子 (7,8)
    const aMoved = await clickCell(pageA, 7, 8, 2);
    check('执白方A成功二手落子 (7,8)', aMoved);
    await pageB.waitForFunction(() => window.__gomoku.moves.length === 2, null, { timeout: 5000 });

    // 重开清空测试落子
    await pageA.click('#restart-btn');
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
    await pageB.click('#modal-ok');
    await pageA.waitForFunction(() => window.__gomoku.moves.length === 0, null, { timeout: 5000 });
    await pageB.waitForFunction(() => window.__gomoku.moves.length === 0, null, { timeout: 5000 });
  }

  // 2. 再次申请换边，测试拒绝逻辑
  await pageB.click('#toggle-color-btn');
  if (p2p) {
    await pageA.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  } else {
    await pageA.evaluate(() => window.__gomoku.deliver({ t: 'swap-req' }));
    await pageA.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  }
  await pageA.click('#modal-no');
  if (!p2p) await pageB.evaluate(() => window.__gomoku.deliver({ t: 'swap-no' }));
  await pageA.waitForTimeout(300);
  check('换边拒绝后双方执子颜色保持不变', (await state(pageA)).myColor === 2 && (await state(pageB)).myColor === 1);

  // 3. 换边后再换回来以保持后续测试的默认顺序
  await pageA.click('#toggle-color-btn');
  if (p2p) {
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  } else {
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'swap-req' }));
    await pageB.waitForSelector('#modal-mask:not(.hidden)', { timeout: 5000 });
  }
  await pageB.click('#modal-ok');
  if (!p2p) await pageA.evaluate(() => window.__gomoku.deliver({ t: 'swap-ok' }));
  await pageA.waitForFunction(() => window.__gomoku.myColor === 1, null, { timeout: 5000 });
  await pageB.waitForFunction(() => window.__gomoku.myColor === 2, null, { timeout: 5000 });
  check('换回原执子角色成功（A 恢复执黑，B 恢复执白）', true);

  if (p2p) {
    await pageA.click('#toggle-color-btn');
    await pageB.waitForSelector('#modal-mask:not(.hidden)');
    await pageA.evaluate(() => window.__gameplayTest.channels.at(-1).close());
    await pageA.waitForFunction(() => !window.__gomoku.connected);
    await pageA.click('#toggle-color-btn');
    check('重连期间不能私自修改执子颜色', (await state(pageA)).myColor === 1);
    await pageA.waitForFunction(() => window.__gomoku.connected, null, { timeout: 45000 });
    await pageB.waitForFunction(() => window.__gomoku.connected, null, { timeout: 10000 });
    check('恢复后双方仍分别执黑执白', (await state(pageA)).myColor === 1 && (await state(pageB)).myColor === 2);
    check('断线取消旧换边弹窗', !(await pageB.locator('#modal-mask').isVisible()));
    await pageA.click('#toggle-color-btn');
    await pageB.waitForSelector('#modal-mask:not(.hidden)');
    check('恢复后可以重新发起换边申请', true);
    await pageB.click('#modal-no');
    await pageA.waitForFunction(() => document.getElementById('toast').textContent.includes('拒绝'));

    // Lose a swap confirmation, then delay the authoritative color during recovery.
    await pageB.evaluate(() => { window.__gameplayTest.hold = true; });
    await pageA.click('#toggle-color-btn');
    await pageB.waitForSelector('#modal-mask:not(.hidden)');
    await pageB.click('#modal-ok');
    await pageB.waitForFunction(() => window.__gomoku.myColor === 1);
    await pageA.evaluate(() => {
      window.__gameplayTest.holdColor = true;
      window.__gameplayTest.channels.at(-1).close();
    });
    await pageB.evaluate(() => {
      window.__gameplayTest.hold = false;
      window.__gameplayTest.queue = [];
    });
    await pageA.waitForFunction(() => !window.__gomoku.connected);
    await pageA.waitForFunction(() => window.__gomoku.connected, null, { timeout: 45000 });
    await pageB.waitForFunction(() => window.__gomoku.connected, null, { timeout: 10000 });
    await pageB.locator('#board').click({ position: { x: PAD + 7 * CELL, y: PAD + 7 * CELL } });
    check('换边确认丢失后加入方等待颜色同步，不能抢先落子', (await state(pageB)).moves === 0);
    await pageA.evaluate(() => window.__gameplayTest.flush());
    await pageB.waitForFunction(() => window.__gomoku.myColor === 2);
    check('恢复时按房主颜色消除单侧已换边的状态', (await state(pageA)).myColor === 1 && (await state(pageB)).myColor === 2);
  }

  /* ---------- 手数切换开关 (R2) ---------- */
  check('初始手数状态为隐藏 (showMoveNumbers=false)', !(await pageA.evaluate(() => window.__gomoku.showMoveNumbers)));
  const btnTextBefore = (await pageA.textContent('#toggle-move-numbers-btn')).trim();
  check('手数按钮初始文案显示「显示手数」', btnTextBefore === '显示手数');
  await pageA.click('#toggle-move-numbers-btn');
  await pageA.waitForFunction(() => window.__gomoku.showMoveNumbers === true, null, { timeout: 3000 });
  const btnTextAfter = (await pageA.textContent('#toggle-move-numbers-btn')).trim();
  check('点击后手数状态开启 (showMoveNumbers=true) 且文案切换为「隐藏手数」', btnTextAfter === '隐藏手数');
  await pageA.click('#toggle-move-numbers-btn');
  await pageA.waitForFunction(() => window.__gomoku.showMoveNumbers === false, null, { timeout: 3000 });
  check('再次点击平滑恢复为隐藏状态', true);

  /* ---------- 换房不残留（回归：上一房间数据不得带到下一房间） ---------- */
  console.log('== 阶段二·补：换房不残留 ==');
  // 造出「上一房间已有数据」的局面：A 落一子 + 发一条聊天
  await clickCell(pageA, 7, 7, 1);
  if (p2p) {
    await pageB.waitForFunction(() => window.__gomoku.moves.length === 1, null, { timeout: 8000 });
  } else {
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'move', x: 7, y: 7 }));
  }
  await pageA.getByRole('tab', { name: /聊天/ }).click();
  await pageA.fill('#chat-input', '上一局的消息');
  await pageA.click('#chat-send-btn');
  if (!p2p) await pageB.evaluate(() => window.__gomoku.deliver({ t: 'chat', text: '上一局的消息' }));
  await pageA.waitForFunction(() => document.querySelectorAll('#chat-list .msg.mine').length === 1, null, { timeout: 5000 })
    .catch(() => {});
  const beforeSwitch = await pageA.evaluate(() => ({
    moves: window.__gomoku.moves.length,
    mine: document.querySelectorAll('#chat-list .msg.mine').length,
    peerName: window.__gomoku.peerName,
  }));
  check(
    `换房前 A 已有一局数据（落子 ${beforeSwitch.moves} / 聊天 ${beforeSwitch.mine} / 对手 ${beforeSwitch.peerName}）`,
    beforeSwitch.moves === 1 && beforeSwitch.mine >= 1 && beforeSwitch.peerName === '小红'
  );

  await pageA.getByRole('tab', { name: '对局', exact: true }).click();

  // A 在同一页面直接创建新房间（不刷新页面），旧房间号极小概率重复则重试
  let room2 = room;
  for (let i = 0; i < 3 && room2 === room; i++) {
    await pageA.click('#create-room-btn');
    await pageA.waitForTimeout(400);
    room2 = (await pageA.textContent('#room-code-text')).trim();
  }
  await pageA.waitForFunction(() => window.__gomoku.connected === false, null, { timeout: 5000 })
    .catch(() => {});
  const afterA = await pageA.evaluate(() => ({
    room: window.__gomoku.room,
    moves: window.__gomoku.moves.length,
    over: window.__gomoku.over,
    peerName: window.__gomoku.peerName,
    connected: window.__gomoku.connected,
    msgs: document.querySelectorAll('#chat-list .msg').length,
  }));
  check(`换房后 A 房间号更新（${room} → ${afterA.room}）`, /^[A-Z0-9]{4}$/.test(afterA.room) && afterA.room !== room);
  check('换房后 A 棋盘清空', afterA.moves === 0 && afterA.over === false);
  check('换房后 A 聊天记录清空', afterA.msgs === 0);
  check('换房后 A 对手昵称清空', afterA.peerName === '');
  check('换房后 A 连接状态复位（不显示已直连）', afterA.connected === false);

  // B 应收到 peer-left：保留房号，但棋局 / 聊天 / 对手信息全部复位
  await pageB.waitForFunction(
    () => window.__gomoku.connected === false && window.__gomoku.moves.length === 0,
    null, { timeout: 8000 }
  ).then(() => check('对手离开后 B 连接状态与棋局复位', true))
   .catch(() => check('对手离开后 B 连接状态与棋局复位', false));
  const afterB = await pageB.evaluate(() => ({
    room: window.__gomoku.room,
    peerName: window.__gomoku.peerName,
    mine: document.querySelectorAll('#chat-list .msg.mine').length,
    theirs: document.querySelectorAll('#chat-list .msg.theirs').length,
    sys: document.querySelectorAll('#chat-list .msg.sys').length,
    sysText: Array.from(document.querySelectorAll('#chat-list .msg.sys'))
      .map((el) => el.textContent || '')
      .join(' | '),
    status: document.getElementById('room-status').textContent.trim(),
    state: window.__gomoku.connState,
  }));
  check(`对手离开后 B 保留原房间号 ${afterB.room}`, afterB.room === room);
  check('对手离开后 B 上一局聊天清空（仅剩系统提示）', afterB.mine === 0 && afterB.theirs === 0 && afterB.sys >= 1);
  check('对手离开后 B 对手昵称清空', afterB.peerName === '');
  // 契约变更（QA 缺陷 1 修复）：对手真的离开后不再停在「未连接 / FAILED」，
  // 而是清盘 + 回到同一房间「等待对手加入」；「对手已离开」改由系统消息承载。
  check(`对手离开后 B 状态提示「等待对手加入」（${afterB.status}）`, afterB.status.includes('等待对手加入'));
  check(`对手离开后 B 有「对手已离开」系统消息（${afterB.sysText}）`, afterB.sysText.includes('对手已离开'));
  check(`对手离开后 B 不是 FAILED（${afterB.state}）`, afterB.state === 'ROOM_WAITING');

  console.log('== 阶段二·补2：输错房号不会把自己踢出当前房间 ==');
  // 验证本测试的房间仍能接入和协商，避免依赖会被其他玩家/宽限回收影响的全局房间数。
  const roomBeforeBadJoin = await pageA.evaluate(() => window.__gomoku.room);
  const peersBeforeBadJoin = await pageA.evaluate(() => window.__gameplayTest.peers.length);
  await pageA.fill('#room-input', 'ZZZZ');
  await pageA.click('#join-room-btn');
  const toastText = await pageA
    .waitForFunction(
      () => {
        const el = document.getElementById('toast');
        const text = el ? (el.textContent || '').trim() : '';
        return text.includes('不存在') ? text : false;
      },
      null,
      { timeout: 3000 }
    )
    .then((handle) => handle.jsonValue())
    .catch(() => '');
  const roomAfterBadJoin = await pageA.evaluate(() => window.__gomoku.room);
  check(`输错房号提示「房间 ZZZZ 不存在」（${toastText}）`, toastText.includes('不存在'));
  check(`输错房号后 A 仍在原房间 ${roomAfterBadJoin}`, roomAfterBadJoin === roomBeforeBadJoin);
  await pageB.fill('#room-input', roomBeforeBadJoin);
  await pageB.click('#join-room-btn');
  const originalRoomRetained = await Promise.all([
    pageA.waitForFunction((count) => window.__gameplayTest.peers.length > count && window.__gomoku.signalingState === 'stable',
      peersBeforeBadJoin, { timeout: 5000 }),
    pageB.waitForFunction((code) => window.__gomoku.room === code && window.__gomoku.signalingState === 'stable',
      roomBeforeBadJoin, { timeout: 5000 }),
  ]).then(() => true).catch(() => false);
  check('输错房号后原房间仍能接入，原玩家仍能完成双方协商', originalRoomRetained);

  console.log('== 阶段三：邀请对局（手动信令 · 微信互发） ==');
  const pageC = await newPlayerPage('C');
  const pageD = await newPlayerPage('D');
  await pageC.fill('#name-input', '小刚');
  await pageD.fill('#name-input', '小美');
  await pageC.click('[data-online-tab="manual"]');
  await pageD.click('[data-online-tab="manual"]');

  // C 创建房间（邀请方）→ 生成邀请码
  await pageC.click('#flow-host-btn');
  await pageC.waitForFunction(() => window.__gomoku.flow === 'host-wait', null, { timeout: 5000 });
  await pageC.waitForFunction(() => document.getElementById('flow-host-out').value.length > 0, null, { timeout: 20000 });
  const offerCode = await pageC.inputValue('#flow-host-out');
  check(`邀请码生成（压缩后 ${offerCode.length} 字符）`, offerCode.length > 50);
  check('邀请方步骤条 ① 激活', await pageC.evaluate(() => document.getElementById('fstep-1').classList.contains('active')));
  check('邀请方微信发送提示可见', await pageC.evaluate(() => !!document.querySelector('#flow-host .wechat-tip')));

  // D 加入房间（被邀请方）→ 粘贴邀请码 → 生成应答码
  await pageD.click('#flow-guest-btn');
  await pageD.fill('#flow-guest-in', offerCode);
  await pageD.click('#flow-guest-answer');
  await pageD.waitForFunction(() => window.__gomoku.flow === 'guest-wait', null, { timeout: 20000 });
  await pageD.waitForFunction(() => document.getElementById('flow-guest-out').value.length > 0, null, { timeout: 20000 });
  const answerCode = await pageD.inputValue('#flow-guest-out');
  check('应答码生成', answerCode.length > 50);
  check('被邀请方步骤条 ② 激活', await pageD.evaluate(() => document.getElementById('fstep-2').classList.contains('active')));

  // 交叉应用对方的连接码：验证压缩编解码 + SDP 处理
  await pageC.fill('#flow-host-in', answerCode);
  await pageC.click('#flow-host-finish');
  await pageC.waitForTimeout(1500);
  const sc = await state(pageC);
  const sd = await state(pageD);
  check('host 成功解析应答码（stable）', sc.signalingState === 'stable');
  check('guest 成功解析邀请码并应答（stable）', sd.signalingState === 'stable');

  let manualP2p = false;
  try {
    await pageC.waitForFunction(() => window.__gomoku.connected, null, { timeout: P2P_TIMEOUT });
    manualP2p = true;
  } catch (e) { /* 环境阻断 */ }
  if (manualP2p) {
    check('邀请对局 P2P 连通', true);
    const transport = await pageC.evaluate(() => window.__gomoku.transport);
    const tLine = await pageC.evaluate(() => ({
      visible: document.getElementById('transport-line').offsetParent !== null,
      label: document.getElementById('transport-label').textContent,
    }));
    // TransportInfo 的字段是 candidateType/ipVersion/rtt/summary（没有 label）；
    // UI 的 #transport-label 直接渲染 summary，故同时校验「识别到类型」与「UI 展示一致」
    check(
      '连接方式已识别（IPv4/IPv6/NAT）',
      !!transport &&
        !!transport.summary &&
        !!transport.ipVersion &&
        tLine.visible &&
        tLine.label === transport.summary
    );
    console.log('  连接方式:', JSON.stringify(transport), '| UI:', JSON.stringify(tLine));
    await clickCell(pageC, 7, 7, 1);
    await pageD.waitForFunction(() => window.__gomoku.moves.length === 1, null, { timeout: 8000 });
    check('邀请对局落子同步', true);
  } else {
    if (REQUIRE_P2P) check('邀请对局必须建立真实 DataChannel', false);
    // 15 秒诊断兜底应展示失败原因
    await pageC.waitForTimeout(16000);
    const diag = await pageC.evaluate(() => {
      const r = document.getElementById('flow-result');
      return { visible: r.offsetParent !== null, bad: r.classList.contains('bad'), text: r.textContent.slice(0, 60) };
    });
    check('连接失败时展示原因诊断', diag.visible && diag.bad && diag.text.includes('连接失败'));
    console.log('  (本环境 ICE 被阻断，SDP 交换 + 失败诊断已验证，仅缺 ICE 打通)');
  }

  await browser.close();
  console.log(`\n${failures.length === 0 ? 'E2E 全部通过' : 'E2E 存在失败项: ' + failures.join(' | ')}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 运行异常：', e);
  process.exit(1);
});
