import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 人机模式接线守卫（T05 ①，沿用 app-wiring.test.ts 的源码结构断言风格）
 *
 * 为什么用「读源码」而不是渲染：
 * 仓库没有 @testing-library，且这里要守的不是行为而是**边界**——
 * 「联机路径不得引用人机状态」这类红线在浏览器里几乎无法复现，
 * 但用结构断言可以一次性钉死：`useConnection({...})` 的参数块里不许出现 `ai`。
 */

const WEB_SRC = join(process.cwd(), 'packages/web/src');

/** 读取源码并剥掉注释（注释里出现技术名词是合理的，不算违规） */
function codeOf(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** 从 `from` 起按括号配平截取一段代码（用于只检查某个对象字面量/函数体） */
function balanced(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(from, i + 1);
    }
  }
  return code.slice(from);
}

/** 截取 `marker` 之后第一个 `{` 起的配平代码块 */
function blockAfter(code: string, marker: string): string {
  const start = code.indexOf(marker);
  expect(start, `源码里找不到 ${marker}`).toBeGreaterThanOrEqual(0);
  const brace = code.indexOf('{', start + marker.length);
  expect(brace, `${marker} 后面没有对象/函数体`).toBeGreaterThanOrEqual(0);
  return balanced(code, brace);
}

describe('联机路径与人机路径隔离（架构 §6 红线）', () => {
  it('useConnection({...}) 的参数块内不出现 ai', () => {
    const code = codeOf('App.tsx');
    const options = blockAfter(code, 'useConnection(');

    // \bai\b 只匹配独立的标识符 ai，不会误伤 awaitingColorRef 之类的名字
    expect(options).not.toMatch(/\bai\b/);
    expect(options).not.toContain('useAiGame');
  });

  it('onMovesReplaced 只写联机棋局（setGame），不碰人机状态', () => {
    const code = codeOf('App.tsx');
    const block = blockAfter(code, 'onMovesReplaced:');

    expect(block).toContain('setGame(');
    expect(block).not.toMatch(/\bai\b/);
    expect(block).not.toContain('useAiGame');
  });

  it('联机消息处理器（onlineMessages.ts）不 import 任何人机模块', () => {
    const code = codeOf(join('connection', 'onlineMessages.ts'));

    expect(code).not.toContain('useAiGame');
    expect(code).not.toContain('aiGame');
    expect(code).not.toMatch(/\bai\./);
    // 联机分支只允许 setGame 改棋局
    expect(code).toContain('setGame(');
  });

  it('App.tsx 仍然不自建 WebSocket / RTCPeerConnection', () => {
    const code = codeOf('App.tsx');

    expect(code).not.toContain('new WebSocket(');
    expect(code).not.toContain('new RTCPeerConnection(');
    expect(code).not.toContain('console.');
  });
});

describe('人机模式的接线（T05）', () => {
  it('App 用单一视图派生喂 Board / GameStatus（不直接传联机 game）', () => {
    const code = codeOf('App.tsx');

    expect(code).toContain('const view = mode === ');
    expect(code).toContain('board={view.game.board}');
    expect(code).toContain('moves={view.game.moves}');
    expect(code).toContain('myColor={view.myColor}');
    expect(code).toContain('thinking={mode === ');
    expect(code).toContain('aiColor={mode === ');
  });

  it('handleLocalMove 先分流人机，再走联机守卫', () => {
    const code = codeOf('App.tsx');
    const body = blockAfter(code, 'const handleLocalMove = useCallback(');
    const aiBranch = body.indexOf("if (mode === 'ai')");
    const onlineGuard = body.indexOf('if (!connected)');

    expect(aiBranch).toBeGreaterThanOrEqual(0);
    expect(onlineGuard).toBeGreaterThanOrEqual(0);
    expect(aiBranch).toBeLessThan(onlineGuard);
    expect(body).toContain('ai.play(x, y)');
  });

  it('人机模式隐藏联机面板与聊天区，改为渲染 AiPanel', () => {
    const code = codeOf('App.tsx');

    expect(code).toContain('<AiPanel');
    expect(code).toContain('<ConnectionPanel');
    expect(code).toContain('mode === \'online\' && (');
    expect(code).toContain('mode === \'online\' && (');
  });

  it('Header 挂载 ModeSwitch，模式是纯视图态（默认联机）', () => {
    const header = codeOf(join('components', 'Header', 'Header.tsx'));
    const app = codeOf('App.tsx');

    expect(header).toContain('<ModeSwitch');
    expect(app).toContain("useState<GameMode>('online')");
    expect(app).toContain('onModeChange={setMode}');
  });

  it('Board 新增的两个 props 全部可选（联机路径零改动）', () => {
    const board = codeOf(join('components', 'Board', 'Board.tsx'));

    expect(board).toMatch(/thinking\?: boolean/);
    expect(board).toMatch(/aiColor\?: PlayerColor/);
  });

  it('useAiGame 的 AI 回合 effect 依赖四要素，且 thinking 先于搜索上屏', () => {
    const code = codeOf(join('ai', 'useAiGame.ts'));
    const deps = code.slice(code.lastIndexOf('}, [game.moves.length'));

    expect(deps).toContain('game.moves.length');
    expect(deps).toContain('mode');
    expect(deps).toContain('settings.playerColor');
    expect(deps).toContain('settings.difficulty');
    expect(code.indexOf('setThinking(true)')).toBeLessThan(code.indexOf('runAiSearch('));
    // 卸载 / 切模式 / 悔棋 / 重开都要能取消
    expect(code).toContain('cancelRef.current');
  });

  it('window.__gomoku.ai 暴露 mode / thinking / moves / difficulty', () => {
    const code = codeOf('App.tsx');
    const block = blockAfter(code, 'get ai()');

    expect(block).toContain('mode');
    expect(block).toContain('thinking: ai.thinking');
    expect(block).toContain('moves:');
    expect(block).toContain('difficulty: ai.difficulty');
  });
});

describe('人机纯逻辑层的自研红线（PRD P0-6 / P0-10）', () => {
  it('aiGame.ts 不自研胜负判定，只用 core 的 applyMove / undo', () => {
    const code = codeOf(join('ai', 'aiGame.ts'));

    expect(code).toContain('applyMove(');
    expect(code).toContain('undo(');
    expect(code).not.toContain('winLineAt');
    expect(code).not.toMatch(/count\s*=\s*5|>=\s*5/);
  });

  it('ai/ 目录里没有 Math.random，且 performance 只出现在 searchDriver.ts', () => {
    const files = ['aiGame.ts', 'aiStorage.ts', 'aiLabels.ts', 'useAiGame.ts', 'searchDriver.ts'];

    for (const file of files) {
      const code = codeOf(join('ai', file));
      expect(code, `${file} 出现了 Math.random`).not.toContain('Math.random');
      if (file !== 'searchDriver.ts') {
        expect(code, `${file} 直接读了 performance`).not.toContain('performance');
      }
    }
    expect(codeOf(join('ai', 'searchDriver.ts'))).toContain('performance.now()');
  });

  it('UI 只传 Difficulty，不出现棋力魔数（预算 / 深度 / 节点数）', () => {
    const app = codeOf('App.tsx');
    const panel = codeOf(join('components', 'AiPanel', 'AiPanel.tsx'));

    for (const code of [app, panel]) {
      expect(code).not.toContain('timeBudgetMs');
      expect(code).not.toContain('maxDepth');
      expect(code).not.toContain('maxNodes');
    }
  });
});
