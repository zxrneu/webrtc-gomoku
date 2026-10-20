/** 悔棋和重开的本地协商状态；确认只作用于对应请求、会话与棋谱。 */
import { useEffect, useRef } from 'react';
import { create, undo, type GameState } from '@webrtc-gomoku/core';
import type { GameMessage } from '@webrtc-gomoku/shared';
import type { ModalState } from '../types';

export type GameRequestKind = 'undo' | 'restart';
interface Context { active: boolean; session: unknown; room: string | null }
interface Options {
  gameRef: { current: GameState };
  context: Context;
  setGame: (game: GameState) => void;
  send: (msg: GameMessage) => boolean;
  setModal: (value: ModalState | ((prev: ModalState) => ModalState)) => void;
  showToast: (text: string) => void;
  addSysMsg: (text: string) => void;
  isBlocked: () => boolean;
  isModalOpen: () => boolean;
  generateId: () => string;
}
interface Request { kind: GameRequestKind; board: string; id: string }
export interface GameRequests {
  request: (kind: GameRequestKind) => void;
  handle: (message: GameMessage) => boolean;
  invalidate: () => void;
  hasPending: () => boolean;
}
const label = (kind: GameRequestKind): string => kind === 'undo' ? '悔棋' : '重新开始';
const boardKey = (game: GameState): string => JSON.stringify([game.moves, game.over]);

class GameRequestController implements GameRequests {
  private outgoing: Request | null = null;
  private incoming: Request | null = null;
  private previous: Context;
  private closeTitle: string | null = null;
  private decline: { request: Request; context: Context } | null = null;
  private readonly answered = new Map<string, boolean>();
  constructor(private readonly read: () => Options) { this.previous = read().context; }

  closeDialog(): void {
    const rejected = this.decline;
    this.decline = null;
    if (rejected && rejected.context.session === this.read().context.session && rejected.context.room === this.read().context.room) {
      this.sendAnswer(rejected.request, false);
    }
    const title = this.closeTitle;
    this.closeTitle = null;
    if (title) this.read().setModal(m => m.title === title ? { ...m, open: false } : m);
  }
  private clearIncoming(reject = false): void {
    if (this.incoming && reject) this.decline = { request: this.incoming, context: this.read().context };
    if (this.incoming) this.closeTitle = `对方申请${label(this.incoming.kind)}`;
    this.incoming = null;
  }
  reconcile(): void {
    const { context, gameRef } = this.read();
    const changedSession = context.session !== this.previous.session || context.room !== this.previous.room;
    const changedMode = context.active !== this.previous.active;
    this.previous = context;
    if (this.outgoing && (changedSession || changedMode || this.outgoing.board !== boardKey(gameRef.current))) this.outgoing = null;
    if (this.incoming && (changedMode || changedSession || this.incoming.board !== boardKey(gameRef.current))) this.clearIncoming(!changedSession);
  }
  invalidate(): void {
    this.outgoing = null;
    this.clearIncoming();
    this.closeDialog();
  }
  hasPending(): boolean { this.reconcile(); return !!this.incoming || !!this.outgoing; }

  private commit(kind: GameRequestKind): void {
    const { gameRef, setGame } = this.read();
    const next = kind === 'restart' ? create() : {
      ...gameRef.current, board: gameRef.current.board.map(row => [...row]), moves: [...gameRef.current.moves],
    };
    if (kind === 'undo') undo(next);
    gameRef.current = next;
    setGame(next);
  }
  request(kind: GameRequestKind): void {
    this.reconcile(); this.closeDialog();
    const options = this.read();
    if (!options.context.active || options.isBlocked()) return;
    if (this.outgoing || this.incoming || options.isModalOpen()) { options.showToast('请先完成当前申请'); return; }
    if (kind === 'undo' && (options.gameRef.current.over || !options.gameRef.current.moves.length)) return;
    const pending = { kind, board: boardKey(options.gameRef.current), id: options.generateId() };
    this.outgoing = pending;
    if (!options.send({ t: `${kind}-req`, requestId: pending.id })) {
      if (this.outgoing === pending) this.outgoing = null;
      options.showToast(`${label(kind)}申请发送失败，请检查连接状态`);
      return;
    }
    options.showToast(`已发送${label(kind)}申请，等待对方同意…`);
  }
  private sendAnswer(request: Request, accepted: boolean): boolean {
    if (!this.read().send({ t: `${request.kind}-${accepted ? 'ok' : 'no'}`, requestId: request.id })) return false;
    this.answered.set(`${request.kind}:${request.id}`, accepted);
    const oldest = this.answered.keys().next().value;
    if (this.answered.size > 64 && oldest !== undefined) this.answered.delete(oldest);
    return true;
  }
  private answer(pending: Request, accepted: boolean): void {
    this.reconcile(); this.closeDialog();
    if (this.incoming !== pending || !this.read().context.active) return;
    this.clearIncoming(); this.closeDialog();
    const options = this.read();
    if (!this.sendAnswer(pending, accepted)) {
      options.showToast(`${label(pending.kind)}确认发送失败，请检查连接状态`);
      return;
    }
    if (accepted) this.commit(pending.kind);
    options.addSysMsg(accepted ? `你同意了对方的${label(pending.kind)}申请` : `你拒绝了对方的${label(pending.kind)}申请`);
  }
  private receiveRequest(kind: GameRequestKind, id?: string): void {
    const options = this.read();
    // 旧协议没有关联标识：明确拒绝，避免用户同意后无法安全识别回执。
    if (!id) {
      options.send({ t: `${kind}-no` }); options.showToast('对方版本较旧，请双方刷新页面后再申请'); return;
    }
    if (this.incoming?.id === id && this.incoming.kind === kind) return;
    const pending = { kind, id, board: boardKey(options.gameRef.current) };
    const answered = this.answered.get(`${kind}:${id}`);
    if (answered !== undefined) { this.sendAnswer(pending, answered); return; }
    if (!options.context.active || options.isBlocked() || this.outgoing || this.incoming || options.isModalOpen()) {
      this.sendAnswer(pending, false); return;
    }
    if (kind === 'undo' && !options.gameRef.current.moves.length) { this.sendAnswer(pending, false); return; }
    this.incoming = pending;
    options.setModal({ open: true, title: `对方申请${label(kind)}`,
      text: kind === 'undo' ? '对手希望能撤回最后一手，是否同意？' : '对手希望能重开一局，是否同意？',
      onOk: () => this.answer(pending, true), onNo: () => this.answer(pending, false),
    });
  }
  private receiveReply(kind: GameRequestKind, accepted: boolean, id?: string): void {
    const pending = this.outgoing;
    if (!pending || pending.kind !== kind) return;
    if (id !== pending.id) {
      if (!id) this.read().showToast('对方版本不匹配，请双方刷新页面后重试');
      return;
    }
    this.outgoing = null;
    if (!this.read().context.active) return;
    if (accepted) this.commit(kind);
    const text = `对方${accepted ? '同意' : '拒绝'}了${label(kind)}`;
    this.read().showToast(text); this.read().addSysMsg(text);
  }
  handle(msg: GameMessage): boolean {
    this.reconcile(); this.closeDialog();
    switch (msg.t) {
      case 'undo-req': this.receiveRequest('undo', msg.requestId); return true;
      case 'restart-req': this.receiveRequest('restart', msg.requestId); return true;
      case 'undo-ok': this.receiveReply('undo', true, msg.requestId); return true;
      case 'undo-no': this.receiveReply('undo', false, msg.requestId); return true;
      case 'restart-ok': this.receiveReply('restart', true, msg.requestId); return true;
      case 'restart-no': this.receiveReply('restart', false, msg.requestId); return true;
      default: return false;
    }
  }
}

/** IO 由 read 注入，单测可用确定的 requestId 和纯内存棋局。 */
export function createGameRequests(read: () => Options) { return new GameRequestController(read); }

/** React 只负责提供最新依赖和清理；消息、按钮共用同一份请求状态。 */
export function useGameRequests(options: Omit<Options, 'generateId'>): GameRequests {
  const latest = useRef(options);
  latest.current = options;
  const ref = useRef<GameRequestController | null>(null);
  if (!ref.current) ref.current = createGameRequests(() => ({ ...latest.current, generateId: () => {
    const words = globalThis.crypto.getRandomValues(new Uint32Array(4));
    return Array.from(words, word => word.toString(16).padStart(8, '0')).join('');
  } }));
  const requests = ref.current;
  requests.reconcile();
  useEffect(() => { requests.closeDialog(); });
  useEffect(() => () => requests.invalidate(), [requests]);
  return requests;
}
