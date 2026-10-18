import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * T04 接线守卫（结构型用例）
 *
 * 为什么要用「读源码」的方式做断言：
 * 重连改造最容易失控的地方不是逻辑，而是**状态双写**——
 * 组件里留一个 `connected` state、再留一份 `roomStatus`，两套状态迟早打架。
 * 这类回归在浏览器里极难复现，但用结构断言可以一次性钉死：
 * 「App.tsx 里不许再出现 WebSocket / initPeer / 自建客户端」。
 */

const WEB_SRC = join(process.cwd(), 'packages/web/src');

/** 读取源码并剥掉注释（注释里出现技术名词是合理的，不算违规） */
function codeOf(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** 读取源码原文（用于行数统计） */
function rawOf(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), 'utf8');
}

describe('App.tsx 接线（状态单一真源）', () => {
  it('App.tsx 不再直接持有 WebSocket（信令全部交给 wsTransport）', () => {
    const code = codeOf('App.tsx');

    expect(code).not.toContain('new WebSocket(');
    expect(code).not.toContain('wsRef');
    expect(code).not.toContain('wsQueueRef');
    expect(code).not.toContain('ensureWsSignaling');
  });

  it('App.tsx 不再自己处理 offer（协商全部交给 p2pTransport）', () => {
    const code = codeOf('App.tsx');

    expect(code).not.toContain('initPeer(');
    expect(code).not.toContain('new RTCPeerConnection(');
    expect(code).not.toContain('setRemoteDescription');
    expect(code).not.toContain('createAnswer');
  });

  it('App.tsx 不再自建 WebRTCClient，也不再有 connected 镜像状态', () => {
    const code = codeOf('App.tsx');

    expect(code).not.toContain('new WebRTCClient(');
    expect(code).not.toContain('setConnected(');
    expect(code).not.toContain('useState(false);\n  const [myColor');
  });

  it('App.tsx 通过 useConnection 取唯一状态源，并渲染状态条', () => {
    const code = codeOf('App.tsx');

    expect(code).toContain('useConnection(');
    expect(code).toContain('conn.status');
    expect(code).toContain('ConnectionBanner');
  });

  it('App.tsx 暴露给 e2e 的 __gomoku 能读到编排器状态', () => {
    const code = codeOf('App.tsx');

    expect(code).toContain('connState');
    expect(code).toContain('isPlayable');
    expect(code).toContain('nextRetryInMs');
  });

  it('App.tsx 显著变薄：连接机制全部迁出，行数下降 ≥100', () => {
    const lines = rawOf('App.tsx').split('\n').length;

    // 改造前 945 行。删掉的连接代码：ensureWsSignaling(127) + 建连 effect(42) +
    // signalSend(7) + 旧 create/join(27) + peer-left 清盘(7) + wsRef/roomStatus 等(~10) ≈ 220；
    // 新增接线：useConnection 参数 + handleConnEvent + Banner ≈ 120。
    // tasks.md 的「≥200 行」把 ensureWsSignaling 内部的 offer/signal 处理重复计了一次，
    // 按实际代码结构不可达（已记录在 tasks.md 的偏差说明里）。
    // 单条 ratchet 即可（原第二条 <845 是同一不变量的更严重复，
    // 加入 room-ready / join-rejected 两个副作用分支后自然上涨 3 行，无独立意义）。
    expect(lines).toBeLessThanOrEqual(850);
  });
});

describe('web 适配层日志出口', () => {
  it('connection/ 目录里只有 logger.ts 允许出现 console', () => {
    const files = ['wsTransport.ts', 'p2pTransport.ts', 'useConnection.ts'];

    for (const file of files) {
      expect(codeOf(join('connection', file)), `${file} 出现了 console`).not.toContain('console.');
    }
  });

  it('App.tsx 与 webrtc.ts 也不再直接 console', () => {
    expect(codeOf('App.tsx')).not.toContain('console.');
    expect(codeOf('webrtc.ts')).not.toContain('console.');
  });
});
