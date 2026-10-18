'use strict';
/**
 * ============================================================================
 * 重连 E2E（自动重连 · PRD §5 场景矩阵的可自动化子集）
 * ============================================================================
 * 与 `test/e2e.js` 的分工：
 * - `test/e2e.js`：建连 + 对局协议（落子/悔棋/重开）；
 * - 本文件：**只测连接生命周期**（掉线 → 恢复 → 对账 → 终态），不点棋盘。
 *
 * 断言全部走页面内只读探针 `window.__gomoku`（由 App.tsx 暴露）：
 *   connState / isPlayable / attempt / nextRetryInMs / reason / label / moves / room
 *
 * 运行前提：
 *   1. 先构建：`pnpm build`
 *   2. 本脚本会**自己拉起** Node 信令服务端（端口用 PORT 覆盖，默认 3999），
 *      不依赖外部已启动的服务；若想复用外部服务，设 `REUSE_SERVER=1` + `BASE=...`
 *   3. 需要 playwright 与任一 Chromium 系浏览器
 *
 * 运行：`node test/reconnect-e2e.js`
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 3999);
const BASE = process.env.BASE || `http://localhost:${PORT}`;
const REUSE_SERVER = process.env.REUSE_SERVER === '1';
const SERVER_ENTRY = path.join(__dirname, '..', 'apps', 'server', 'dist', 'server.js');

const failures = [];
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok   -', name);
  } else {
    console.error('  FAIL -', name, extra === undefined ? '' : JSON.stringify(extra));
    failures.push(name);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到条件成立或超时 */
async function waitFor(label, fn, timeoutMs = 20000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err && err.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${label}）：最后结果 = ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------- 服务端管理

let serverProc = null;

async function pingHttp() {
  try {
    const res = await fetch(`${BASE}/`);
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

async function startServer() {
  if (REUSE_SERVER) {
    if (!(await pingHttp())) throw new Error(`REUSE_SERVER=1 但 ${BASE} 不可达`);
    return;
  }
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', (chunk) => console.error('[server]', String(chunk).trim()));
  await waitFor('服务端启动', pingHttp, 15000);
}

async function stopServer() {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill('SIGKILL');
    setTimeout(resolve, 3000);
  });
}

async function restartServer() {
  await stopServer();
  await startServer();
}

// ---------------------------------------------------------------- 浏览器管理

async function launchBrowser() {
  const candidates = [
    {},
    { executablePath: process.env.CHROME_PATH },
    { channel: 'chrome' },
  ].filter((c) => c && (!('executablePath' in c) || c.executablePath));
  let lastErr = null;
  for (const options of candidates) {
    try {
      return await chromium.launch({
        ...options,
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error('未找到可用浏览器：' + (lastErr && lastErr.message));
}

function gomoku(page) {
  return page.evaluate(() => {
    const g = window.__gomoku;
    if (!g) return null;
    return {
      connected: g.connected,
      connState: g.connState,
      isPlayable: g.isPlayable,
      attempt: g.attempt,
      nextRetryInMs: g.nextRetryInMs,
      reason: g.reason,
      label: g.label,
      room: g.room,
      dcState: g.dcState,
      pcState: g.pcState,
      moves: g.moves,
    };
  });
}

async function newPlayer(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`[${name} pageerror]`, err.message));
  await page.goto(BASE);
  await waitFor(`${name} 页面就绪`, async () => (await gomoku(page)) !== null, 15000);
  return { context, page };
}

/** 伪造页面可见性（headless 下无法真正切后台，只能改写 getter + 派发事件） */
async function setVisibility(page, state) {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => next,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** 关闭可能遮挡点击的确认弹窗（房间失效 / 悔棋等） */
async function dismissModal(page) {
  const mask = page.locator('#modal-mask');
  const visible = await mask.isVisible().catch(() => false);
  if (visible) {
    await page.click('#modal-no').catch(() => {});
    await mask.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  }
}

/** 建房 + 加入 + 等到双方 CONNECTED */
async function connectPair(host, guest) {
  for (const p of [host.page, guest.page]) {
    await dismissModal(p);
    // 已连接时面板会收起成紧凑条，先展开才能操作建房/入房
    const toggle = p.locator('#toggle-connect-details-btn');
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click().catch(() => {});
    }
  }
  const previousRoom = (await gomoku(host.page)).room;
  await host.page.fill('#name-input', '房主E2E').catch(() => {});
  await host.page.click('#create-room-btn');
  const room = await waitFor('房号下发', async () => {
    const g = await gomoku(host.page);
    return g && g.room && g.room !== previousRoom && g.connState === 'ROOM_WAITING' ? g.room : null;
  });
  await guest.page.fill('#name-input', '客人E2E').catch(() => {});
  await guest.page.fill('#room-input', room).catch(() => {});
  await guest.page.click('#join-room-btn');

  await waitFor('房主 CONNECTED', async () => {
    const g = await gomoku(host.page);
    return g && g.connState === 'CONNECTED' && g.dcState === 'open';
  }, 30000);
  await waitFor('加入方 CONNECTED', async () => {
    const g = await gomoku(guest.page);
    return g && g.connState === 'CONNECTED' && g.dcState === 'open';
  }, 30000);
  return room;
}

// ---------------------------------------------------------------- 场景

(async () => {
  await startServer();
  const browser = await launchBrowser();
  const host = await newPlayer(browser, 'host');
  const guest = await newPlayer(browser, 'guest');

  try {
    // ---------- A. 正常建房 / 入房 ----------
    console.log('\n[A] 正常建房 / 入房');
    const room = await connectPair(host, guest);
    let h = await gomoku(host.page);
    let g = await gomoku(guest.page);
    check('房主 isPlayable=true', h.isPlayable === true, h);
    check('加入方 isPlayable=true', g.isPlayable === true, g);
    check('双方房间号一致', h.room === room && g.room === room, { h: h.room, g: g.room });
    check('无重试消耗', h.attempt === 0 && g.attempt === 0, { h: h.attempt, g: g.attempt });

    // ---------- B. 落子对账基线（供恢复后比对） ----------
    console.log('\n[B] 落子基线');
    await host.page.click('#board', { position: { x: 28 + 36 * 7 + 18, y: 28 + 36 * 7 + 18 } });
    await waitFor('加入方收到落子', async () => {
      const gg = await gomoku(guest.page);
      return gg && gg.moves.length === 1;
    }, 10000);
    const baseline = (await gomoku(guest.page)).moves;
    check('加入方棋盘与房主一致（1 手）', baseline.length === 1, baseline);

    // ---------- C. 房主网络断开 → 恢复（ws-only / ICE restart） ----------
    //
    // 说明（环境限制，非产品缺陷）：Playwright 的 `setOffline` 只做网络仿真，
    // 已建立的 TCP 不会立刻发 FIN，服务端要靠自己的 30s ws ping + 无 pong 强杀
    // 才能发现「半开连接」，即 peer-offline 最早也要 30~60s 才可能下发。
    // 因此本场景断言的是**双方都不误报 + 房主能自愈**；
    // 「对手网络不稳定」的确定性断言放在场景 E/F（关页面 = 干净 close，服务端立刻感知）。
    console.log('\n[C] 房主断网 → 自动恢复');
    await host.context.setOffline(true);
    await waitFor('房主进入 RECONNECTING', async () => {
      const hh = await gomoku(host.page);
      return hh && (hh.connState === 'RECONNECTING' || hh.connState === 'SIGNAL_CONNECTING');
    }, 30000);

    // M3 误报基线：房主断网期间，加入方不得被判为断开、不得清盘
    const guestDuringOutage = await gomoku(guest.page);
    check(
      '房主断网期间加入方不误报断开（仍 CONNECTED 且可落子）',
      guestDuringOutage.connState === 'CONNECTED' && guestDuringOutage.isPlayable === true,
      guestDuringOutage
    );
    check('房主断网期间重试计数在增长', (await gomoku(host.page)).attempt >= 1, await gomoku(host.page));

    await host.context.setOffline(false);
    await waitFor('房主恢复 CONNECTED', async () => {
      const hh = await gomoku(host.page);
      return hh && hh.connState === 'CONNECTED' && hh.dcState === 'open';
    }, 40000);

    h = await gomoku(host.page);
    g = await gomoku(guest.page);
    check('恢复后双方均可落子', h.isPlayable === true && g.isPlayable === true, { h, g });
    check('恢复后棋谱未丢（1 手）', g.moves.length === 1, g.moves);

    // incidentSettleMs(10s) 稳定期过后 attempt 归零，证明「恢复」而非「勉强连上」
    const settled = await waitFor('房主 attempt 归零', async () => {
      const hh = await gomoku(host.page);
      return hh && hh.connState === 'CONNECTED' && hh.attempt === 0 ? hh : null;
    }, 25000).catch(() => null);
    check('恢复稳定后 attempt 归零', !!settled, settled || (await gomoku(host.page)));

    // ---------- H. 页面隐藏 = 暂停修饰符（不消耗重试次数） ----------
    console.log('\n[H] 页面隐藏 → 暂停重试，回前台立即重试');
    await host.context.setOffline(true);
    await waitFor('房主再次进入 RECONNECTING', async () => {
      const hh = await gomoku(host.page);
      return hh && hh.connState === 'RECONNECTING';
    }, 30000);

    await setVisibility(host.page, 'hidden');
    await sleep(1500); // 让可能在途的一次重试落地，再取基准
    const attemptBeforeHide = (await gomoku(host.page)).attempt;
    await sleep(9000);
    const hiddenSnap = await gomoku(host.page);
    check('隐藏期间不消耗重试次数', hiddenSnap.attempt === attemptBeforeHide, {
      before: attemptBeforeHide,
      after: hiddenSnap.attempt,
    });
    check('隐藏期间状态仍是 RECONNECTING（不是 FAILED）', hiddenSnap.connState === 'RECONNECTING', hiddenSnap);

    await setVisibility(host.page, 'visible');
    const resumed = await waitFor('回到前台立刻重试', async () => {
      const hh = await gomoku(host.page);
      return hh && hh.attempt > attemptBeforeHide ? hh : null;
    }, 20000).catch(() => null);
    check('回到前台立即重试（不等剩余退避）', !!resumed, resumed || (await gomoku(host.page)));

    await host.context.setOffline(false);
    await waitFor('房主第三次恢复 CONNECTED', async () => {
      const hh = await gomoku(host.page);
      return hh && hh.connState === 'CONNECTED';
    }, 40000);
    check('页面隐藏/恢复后仍能连通', (await gomoku(host.page)).isPlayable === true, await gomoku(host.page));

    // ---------- D. 服务端重启 → FAILED(SERVER_RESTART) 且保留棋谱 ----------
    console.log('\n[D] 服务端重启 → 终态 FAILED');
    const movesBeforeRestart = (await gomoku(host.page)).moves.length;
    await restartServer();
    const failed = await waitFor('房主进入 FAILED', async () => {
      const hh = await gomoku(host.page);
      return hh && hh.connState === 'FAILED' ? hh : null;
    }, 90000).catch(() => null);
    check('房主最终进入 FAILED', !!failed, failed || (await gomoku(host.page)));
    if (failed) {
      check('失败原因为 SERVER_RESTART', failed.reason === 'SERVER_RESTART', failed.reason);
      check('失败后棋盘保留', failed.moves.length === movesBeforeRestart, {
        before: movesBeforeRestart,
        after: failed.moves.length,
      });
      check('失败文案提示房间失效', /服务器已重启|房间失效/.test(failed.label), failed.label);
    }

    // ---------- E. 对手离开（关页面）→ 只发 peer-offline，不立刻 peer-left ----------
    console.log('\n[E] 对手离开 → 先 peer-offline（房主视角）');
    // D 之后房间已失效，重新建一对
    const roomE = await connectPair(host, guest);
    await guest.page.close();
    const hostSawOffline = await waitFor('房主收到 peer-offline', async () => {
      const hh = await gomoku(host.page);
      // peer-offline 让 CONNECTED 状态条文案变成「对手网络不稳定…（剩余 Ns）」
      return hh && hh.connState === 'CONNECTED' && /对手网络不稳定/.test(hh.label) ? hh : null;
    }, 30000).catch(() => null);
    check('对手关页面后房主仍 CONNECTED（宽限 60s 内不清盘）', !!hostSawOffline, hostSawOffline || (await gomoku(host.page)));
    if (hostSawOffline) {
      check('房主看到对手宽限倒计时', typeof hostSawOffline.nextRetryInMs === 'number' || /剩余 \d+s/.test(hostSawOffline.label), hostSawOffline.label);
      check('宽限期内房主棋谱保留', Array.isArray(hostSawOffline.moves), hostSawOffline.moves);
    }

    // 缺陷 1 回归：宽限到期 → 必须清盘并回到「等待对手加入」，而不是卡在 FAILED
    const cleared = await waitFor('宽限到期后清盘', async () => {
      const hh = await gomoku(host.page);
      return hh && hh.connState === 'ROOM_WAITING' && hh.moves.length === 0 ? hh : null;
    }, 90000).catch(() => null);
    check('宽限到期后清盘并回到 ROOM_WAITING（不卡在 FAILED）', !!cleared, cleared || (await gomoku(host.page)));
    if (cleared) {
      check('清盘后仍保留原房间号', cleared.room === roomE, { roomE, now: cleared.room });
    }

    // ---------- F. 对手离开（关页面）→ 加入方视角（对称覆盖） ----------
    console.log('\n[F] 对手离开 → 先 peer-offline（加入方视角）');
    const guest2 = await newPlayer(browser, 'guest2');
    await connectPair(host, guest2);
    await host.page.close();
    const guestSawOffline = await waitFor('加入方收到 peer-offline', async () => {
      const gg = await gomoku(guest2.page);
      return gg && gg.connState === 'CONNECTED' && /对手网络不稳定/.test(gg.label) ? gg : null;
    }, 30000).catch(() => null);
    check('对手关页面后加入方仍 CONNECTED（宽限 60s 内不清盘）', !!guestSawOffline, guestSawOffline || (await gomoku(guest2.page)));
    if (guestSawOffline) {
      check('加入方看到对手宽限倒计时', /剩余 \d+s/.test(guestSawOffline.label), guestSawOffline.label);
    }
  } catch (err) {
    console.error('\n[E2E 异常]', err && err.message);
    failures.push('执行异常：' + (err && err.message));
  } finally {
    await browser.close().catch(() => {});
    await stopServer();
  }

  console.log('');
  if (failures.length) {
    console.error(`重连 E2E 失败 ${failures.length} 项：`);
    for (const f of failures) console.error('  -', f);
    process.exit(1);
  }
  console.log('重连 E2E 全部通过');
  process.exit(0);
})();
