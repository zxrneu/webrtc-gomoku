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

const failures = [];
function check(name, cond) {
  if (cond) console.log('  ok -', name);
  else { console.error('  FAIL -', name); failures.push(name); }
}

async function launchBrowser() {
  const candidates = [
    {},
    { executablePath: process.env.CHROME_PATH },
    { executablePath: '/Users/zxr/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' },
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
    await page.goto(BASE);
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
  } else {
    console.log('  (本环境 ICE 被阻断，降级为对局协议仿真)');
    const sa = await state(pageA);
    const sb = await state(pageB);
    check('双方 SDP 协商完成（stable）', sa.signalingState === 'stable' && sb.signalingState === 'stable');
    // 信令链路已通：候选无残留积压
    check('ICE 候选无残留积压', sa.pendingIce === 0 && sb.pendingIce === 0);
    // 模拟“已连接”，让后续点击走真实落子路径（deliver 仿真对端收件）
    await pageA.evaluate(() => window.__gomoku.forceConnected(true));
    await pageB.evaluate(() => window.__gomoku.forceConnected(true));
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
  if (p2p) {
    await pageA.fill('#chat-input', '你好呀');
    await pageA.click('#chat-send-btn');
    await pageB.waitForSelector('.msg.theirs:has-text("你好呀")', { timeout: 5000 });
  } else {
    await pageA.fill('#chat-input', '你好呀');
    await pageA.click('#chat-send-btn');
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'chat', text: '你好呀' }));
    await pageB.waitForSelector('.msg.theirs:has-text("你好呀")', { timeout: 5000 });
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'hello', name: '小红' }));
    await pageA.evaluate(() => window.__gomoku.deliver({ t: 'hello', name: '小明' }));
  }
  check('聊天消息送达对端', true);

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

  /* ---------- 换房不残留（回归：上一房间数据不得带到下一房间） ---------- */
  console.log('== 阶段二·补：换房不残留 ==');
  // 造出「上一房间已有数据」的局面：A 落一子 + 发一条聊天
  await clickCell(pageA, 7, 7, 1);
  if (p2p) {
    await pageB.waitForFunction(() => window.__gomoku.moves.length === 1, null, { timeout: 8000 });
  } else {
    await pageB.evaluate(() => window.__gomoku.deliver({ t: 'move', x: 7, y: 7 }));
  }
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
    status: document.getElementById('room-status').textContent.trim(),
  }));
  check(`对手离开后 B 保留原房间号 ${afterB.room}`, afterB.room === room);
  check('对手离开后 B 上一局聊天清空（仅剩系统提示）', afterB.mine === 0 && afterB.theirs === 0 && afterB.sys >= 1);
  check('对手离开后 B 对手昵称清空', afterB.peerName === '');
  check(`对手离开后 B 状态提示「对手已离开」（${afterB.status}）`, afterB.status.includes('对手已离开'));

  console.log('== 阶段三：邀请对局（手动信令 · 微信互发） ==');
  const pageC = await newPlayerPage('C');
  const pageD = await newPlayerPage('D');
  await pageC.fill('#name-input', '小刚');
  await pageD.fill('#name-input', '小美');
  await pageC.click('.tab[data-tab="manual"]');
  await pageD.click('.tab[data-tab="manual"]');

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
    check('连接方式已识别（IPv4/IPv6/NAT）', !!transport && !!transport.label);
    const tLine = await pageC.evaluate(() => ({
      visible: document.getElementById('transport-line').offsetParent !== null,
      label: document.getElementById('transport-label').textContent,
    }));
    console.log('  连接方式:', JSON.stringify(transport), '| UI:', JSON.stringify(tLine));
    await clickCell(pageC, 7, 7);
    await pageD.waitForFunction(() => window.__gomoku.moves.length === 1, null, { timeout: 8000 });
    check('邀请对局落子同步', true);
  } else {
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
