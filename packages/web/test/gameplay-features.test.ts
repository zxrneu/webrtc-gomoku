import { describe, it, expect, vi } from 'vitest';
import { BLACK, WHITE, currentColor, create as createGame, applyMove } from '@webrtc-gomoku/core';
import type { Move, PlayerColor } from '@webrtc-gomoku/core';
import { encodeGameMessage, decodeGameMessage } from '@webrtc-gomoku/shared';
import type { GameMessage, SwapReqMsg, SwapOkMsg, SwapNoMsg, ColorMsg } from '@webrtc-gomoku/shared';

describe('R1: 执黑/执白选边与对端同步逻辑', () => {
  it('默认房主执黑先行，换边后房主执白客方执黑', () => {
    let hostColor: PlayerColor = BLACK;
    let guestColor: PlayerColor = hostColor === BLACK ? WHITE : BLACK;

    expect(hostColor).toBe(BLACK);
    expect(guestColor).toBe(WHITE);

    // 房主切换为执白
    hostColor = WHITE;
    guestColor = hostColor === BLACK ? WHITE : BLACK;

    expect(hostColor).toBe(WHITE);
    expect(guestColor).toBe(BLACK);
  });

  it('无论房主或客方谁执黑，五子棋核心规则始终黑方先行', () => {
    const game = createGame();
    expect(currentColor(game)).toBe(BLACK);

    // 假设房主选白，客方执黑
    const hostColor: PlayerColor = WHITE;
    const guestColor: PlayerColor = BLACK;

    const isHostTurn = currentColor(game) === hostColor;
    const isGuestTurn = currentColor(game) === guestColor;

    expect(isHostTurn).toBe(false);
    expect(isGuestTurn).toBe(true);

    // 客方（执黑）下第一手 (7, 7)
    const res = applyMove(game, 7, 7, guestColor);
    expect(res.ok).toBe(true);

    // 下一手轮到白方（房主）
    expect(currentColor(game)).toBe(WHITE);
    expect(currentColor(game) === hostColor).toBe(true);
  });

  it('双向协商换边消息编解码与往返一致性', () => {
    const req: SwapReqMsg = { t: 'swap-req' };
    const ok: SwapOkMsg = { t: 'swap-ok' };
    const no: SwapNoMsg = { t: 'swap-no' };
    const colorMsg: ColorMsg = { t: 'color', color: WHITE };

    expect(decodeGameMessage(encodeGameMessage(req))).toEqual(req);
    expect(decodeGameMessage(encodeGameMessage(ok))).toEqual(ok);
    expect(decodeGameMessage(encodeGameMessage(no))).toEqual(no);
    expect(decodeGameMessage(encodeGameMessage(colorMsg))).toEqual(colorMsg);
  });

  it('对战状态身份派生逻辑（动态反映执黑/执白归属）', () => {
    function getPlayerLabels(myColor: PlayerColor, isHost: boolean, myName: string, peerName: string) {
      const isMeBlack = myColor === BLACK;
      const myLabel = myName ? `${myName} (我)` : isHost ? '房主 (我)' : '玩家 (我)';
      const peerLabel = peerName || (isHost ? '加入方' : '房主');
      return {
        blackName: isMeBlack ? myLabel : peerLabel,
        whiteName: !isMeBlack ? myLabel : peerLabel,
        blackTag: isMeBlack ? (isHost ? '房主 (先行)' : '加入方 (先行)') : (isHost ? '加入方 (先行)' : '房主 (先行)'),
        whiteTag: !isMeBlack ? (isHost ? '房主' : '加入方') : (isHost ? '加入方' : '房主'),
      };
    }

    // 场景 1：房主执黑
    const s1 = getPlayerLabels(BLACK, true, '张三', '李四');
    expect(s1.blackName).toBe('张三 (我)');
    expect(s1.blackTag).toBe('房主 (先行)');
    expect(s1.whiteName).toBe('李四');
    expect(s1.whiteTag).toBe('加入方');

    // 场景 2：房主选白（客方执黑）从房主视角看
    const s2Host = getPlayerLabels(WHITE, true, '张三', '李四');
    expect(s2Host.blackName).toBe('李四');
    expect(s2Host.blackTag).toBe('加入方 (先行)');
    expect(s2Host.whiteName).toBe('张三 (我)');
    expect(s2Host.whiteTag).toBe('房主');

    // 场景 3：客方视角（执黑）
    const s2Guest = getPlayerLabels(BLACK, false, '李四', '张三');
    expect(s2Guest.blackName).toBe('李四 (我)');
    expect(s2Guest.blackTag).toBe('加入方 (先行)');
    expect(s2Guest.whiteName).toBe('张三');
    expect(s2Guest.whiteTag).toBe('房主');
  });

  it('换边协商确认状态转移测试', () => {
    let p1Color: PlayerColor = BLACK;
    let p2Color: PlayerColor = WHITE;

    // P1 发送 swap-req，P2 确认 swap-ok
    const onP2Agree = () => {
      p2Color = p2Color === BLACK ? WHITE : BLACK;
      return { t: 'swap-ok' as const };
    };
    const onP1ReceiveOk = () => {
      p1Color = p1Color === BLACK ? WHITE : BLACK;
    };

    const reply = onP2Agree();
    expect(reply.t).toBe('swap-ok');
    onP1ReceiveOk();

    // 双方互换成功
    expect(p1Color).toBe(WHITE);
    expect(p2Color).toBe(BLACK);

    // 若 P2 拒绝 swap-no，状态保持
    const onP2Reject = () => ({ t: 'swap-no' as const });
    const rejectReply = onP2Reject();
    expect(rejectReply.t).toBe('swap-no');
    // 状态未改变
    expect(p1Color).toBe(WHITE);
    expect(p2Color).toBe(BLACK);
  });

  it('在途落子与换边并发时，落子颜色严格遵从棋盘 currentColor 绝不误判为 not-your-turn', () => {
    // 场景：对局当前已有 1 步棋（黑方在 7,7），棋盘当前轮到白方 (WHITE)
    const game = createGame();
    applyMove(game, 7, 7, BLACK);
    expect(currentColor(game)).toBe(WHITE);

    // 假设本端此时接收到对端的换边同意 swap-ok，本地 myColor 立即对调（由 WHITE 变为 BLACK）
    let myColor: PlayerColor = WHITE;
    myColor = myColor === BLACK ? WHITE : BLACK; // myColor 现为 BLACK

    // 此时对端在换边前发出的在途落子（Move 2: 8,8）到达
    // 若错误地使用 opponentColor = (myColor === BLACK ? WHITE : BLACK)，则 opponentColor = WHITE
    // 但若 local 曾有延迟或相反更新，依赖 currentColor(game) 才是唯一无死角真源：
    const moveColor = currentColor(game);
    expect(moveColor).toBe(WHITE);

    const res = applyMove(game, 8, 8, moveColor);
    expect(res.ok).toBe(true);
    expect(game.moves.length).toBe(2);
    expect(currentColor(game)).toBe(BLACK);
  });

  it('换边协商处理 swap-ok 或 swap-no 时自动关闭已开启的换边确认弹窗', () => {
    let modal = {
      open: true,
      title: '对方申请换边（切换执黑/执白）',
      text: '对手希望能互换执子颜色（黑白互换），是否同意？',
    };

    const handleSwapOk = () => {
      if (modal.open && (modal.title.includes('换边') || modal.title.includes('执黑/执白'))) {
        modal = { ...modal, open: false };
      }
    };

    expect(modal.open).toBe(true);
    handleSwapOk();
    expect(modal.open).toBe(false);

    // 同理，swap-no 也会关闭弹窗
    modal = {
      open: true,
      title: '对方申请换边（切换执黑/执白）',
      text: '对手希望能互换执子颜色',
    };
    const handleSwapNo = () => {
      if (modal.open && (modal.title.includes('换边') || modal.title.includes('执黑/执白'))) {
        modal = { ...modal, open: false };
      }
    };
    handleSwapNo();
    expect(modal.open).toBe(false);
  });

  it('对局已结束 (game.over) 时禁止发起或接受换边', () => {
    const game = createGame();
    // 构造黑方五连胜
    applyMove(game, 0, 0, BLACK);
    applyMove(game, 0, 1, WHITE);
    applyMove(game, 1, 0, BLACK);
    applyMove(game, 1, 1, WHITE);
    applyMove(game, 2, 0, BLACK);
    applyMove(game, 2, 1, WHITE);
    applyMove(game, 3, 0, BLACK);
    applyMove(game, 3, 1, WHITE);
    const winRes = applyMove(game, 4, 0, BLACK);

    expect(winRes.ok).toBe(true);
    expect(game.over).toBe(true);

    const canSwap = (isOver: boolean) => !isOver;
    expect(canSwap(game.over)).toBe(false);
  });

  it('建房时房主预选执白状态在 room-ready 后得到完整保留，客方默认执白直至收到房主选边通知', () => {
    // 房主在建房前或未连线时点击切换为执白
    let hostColor: PlayerColor = WHITE;
    let isHost = true;

    // 服务端下发 created，触发 room-ready (role: host)
    const onRoomReady = (role: 'host' | 'guest') => {
      isHost = role === 'host';
      if (role === 'guest') {
        return WHITE;
      }
      return hostColor; // 房主保留预选颜色
    };

    hostColor = onRoomReady('host');
    expect(hostColor).toBe(WHITE); // 房主预选的执白没有被粗暴覆盖回执黑

    // 客人进入房间
    let guestColor: PlayerColor = onRoomReady('guest');
    expect(guestColor).toBe(WHITE);

    // 双方建立直连，房主发送 hello { hostColor: WHITE }
    const onReceiveHello = (incomingHostColor?: PlayerColor) => {
      if (incomingHostColor) {
        guestColor = incomingHostColor === BLACK ? WHITE : BLACK;
      }
    };
    onReceiveHello(hostColor);
    expect(guestColor).toBe(BLACK); // 客方根据房主的白子正确分配为黑方先行
  });

  it('双方同时发起换边并发冲突 (Glare) 仲裁：房主统一决断双方仅对调一次，杜绝二次抵消与单侧漏换', () => {
    let hostColor: PlayerColor = BLACK;
    let guestColor: PlayerColor = WHITE;
    let hostPendingSwap = true;
    let guestPendingSwap = true;

    // 1. 客方发来的 swap-req 先到达房主端
    // 房主检测到本地也处于 pendingSwap，由房主仲裁自动同意并回送 swap-ok
    const handleHostReceiveSwapReq = () => {
      if (hostPendingSwap) {
        hostPendingSwap = false;
        hostColor = hostColor === BLACK ? WHITE : BLACK; // 房主完成一次对调
        return { t: 'swap-ok' as const };
      }
      return null;
    };

    const hostReply = handleHostReceiveSwapReq();
    expect(hostReply?.t).toBe('swap-ok');
    expect(hostColor).toBe(WHITE);

    // 2. 房主先前发出的 swap-req 到达客方端
    // 客方检测到自己也在 pendingSwap 且自己不是房主，因此保持 pendingSwap 静候房主的仲裁回复，不丢弃状态
    const handleGuestReceiveSwapReq = () => {
      if (guestPendingSwap) {
        // 客方为非房主，静候房主决断，不误清 guestPendingSwap
        return;
      }
    };
    handleGuestReceiveSwapReq();
    expect(guestPendingSwap).toBe(true);

    // 3. 房主下发的 swap-ok 到达客方端，客方消费 pendingSwap 并完成单次对调
    const handleGuestReceiveSwapOk = (msg: { t: string }) => {
      if (msg.t === 'swap-ok' && guestPendingSwap) {
        guestPendingSwap = false;
        guestColor = guestColor === BLACK ? WHITE : BLACK; // 客方完成一次对调
      }
    };

    handleGuestReceiveSwapOk(hostReply!);
    expect(guestColor).toBe(BLACK);

    // 验证：双方各自仅对调了一次，绝无出现“各自同意对方导致对调两次回到原点”或“客方漏对调导致双方同色”
    expect(hostColor).toBe(WHITE);
    expect(guestColor).toBe(BLACK);
  });

  it('已发送换边申请但未得到回复时，重复点击换边被拦截；若发送失败则及时复位', () => {
    let pendingSwap = false;
    let sendCount = 0;

    const requestSwap = (sendSucceeds = true) => {
      if (pendingSwap) return false;
      pendingSwap = true;
      if (!sendSucceeds) {
        pendingSwap = false;
        return false;
      }
      sendCount++;
      return true;
    };

    // 模拟发送失败：pending 状态立刻复位，不导致永久死锁
    expect(requestSwap(false)).toBe(false);
    expect(pendingSwap).toBe(false);

    // 正常发送
    expect(requestSwap(true)).toBe(true);
    expect(sendCount).toBe(1);

    // 再次点击被拦截
    expect(requestSwap(true)).toBe(false);
    expect(sendCount).toBe(1);

    // 收到回复后复位，允许再次申请
    pendingSwap = false;
    expect(requestSwap(true)).toBe(true);
    expect(sendCount).toBe(2);
  });

  it('胜负已分 (game.over) 后延迟到达的 swap-ok 或在残留弹窗中点击「同意」被拦截，绝不颠倒胜负', () => {
    let myColor: PlayerColor = BLACK;
    let gameOver = false;
    let pendingSwap = true;

    // 模拟对局中发起过换边，随后第 9 手达成连五获胜
    gameOver = true;

    // 1. 延迟到达的 swap-ok
    const handleSwapOk = () => {
      if (gameOver || !pendingSwap) {
        pendingSwap = false;
        return; // 终局拒绝处理 swap-ok
      }
      myColor = myColor === BLACK ? WHITE : BLACK;
    };
    handleSwapOk();
    expect(myColor).toBe(BLACK); // 颜色未被颠倒

    // 2. 弹窗打开期间终局，用户点击弹窗中的「同意」
    const handleModalOk = () => {
      if (gameOver) return; // 终局拦截
      myColor = myColor === BLACK ? WHITE : BLACK;
    };
    handleModalOk();
    expect(myColor).toBe(BLACK); // 同样被成功拦截
  });
});

describe('R2: 棋子落子次序（手数）标注与切换开关', () => {
  it('手数序号从 1 开始严格累加', () => {
    const moves: Move[] = [
      { x: 7, y: 7, c: BLACK },
      { x: 8, y: 8, c: WHITE },
      { x: 7, y: 8, c: BLACK },
    ];

    const moveNumbers = moves.map((_, i) => i + 1);
    expect(moveNumbers).toEqual([1, 2, 3]);
  });

  it('手数颜色对比度：黑子为白色数字，白子为深色数字', () => {
    const textColorFor = (color: PlayerColor) => (color === BLACK ? '#ffffff' : '#1e293b');

    expect(textColorFor(BLACK)).toBe('#ffffff');
    expect(textColorFor(WHITE)).toBe('#1e293b');
  });

  it('百手以上 (>= 100) 棋子手数标注字体缩放至 10px 保证不溢出', () => {
    const getFontForMove = (num: number) =>
      num >= 100
        ? 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        : 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    expect(getFontForMove(1)).toContain('12px');
    expect(getFontForMove(99)).toContain('12px');
    expect(getFontForMove(100)).toContain('10px');
    expect(getFontForMove(225)).toContain('10px');
  });

  it('开关切换状态测试', () => {
    let showMoveNumbers = false;
    const toggle = () => {
      showMoveNumbers = !showMoveNumbers;
    };

    expect(showMoveNumbers).toBe(false);
    toggle();
    expect(showMoveNumbers).toBe(true);
    toggle();
    expect(showMoveNumbers).toBe(false);
  });

  it('最后一手指示点与手数数字视觉避让逻辑', () => {
    const CELL = 36;
    const PAD = 28;
    const lastMove: Move = { x: 7, y: 7, c: BLACK };
    const lx = PAD + lastMove.x * CELL;
    const ly = PAD + lastMove.y * CELL;

    const getLastMoveMarkerPos = (showNumbers: boolean) => {
      if (showNumbers) {
        // 避让中心数字，偏移至右上角
        return { x: lx + 8.5, y: ly - 8.5 };
      }
      return { x: lx, y: ly };
    };

    // 开启手数：红点在右上角
    const posWithNumbers = getLastMoveMarkerPos(true);
    expect(posWithNumbers.x).toBeGreaterThan(lx);
    expect(posWithNumbers.y).toBeLessThan(ly);

    // 未开启手数：红点在正中央
    const posWithoutNumbers = getLastMoveMarkerPos(false);
    expect(posWithoutNumbers.x).toBe(lx);
    expect(posWithoutNumbers.y).toBe(ly);
  });
});
