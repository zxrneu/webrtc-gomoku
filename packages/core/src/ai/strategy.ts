/** 导入已验证的策略证书，并沿实际棋谱执行；不在策略内的局面返回 null。 */
import type { GameState, PlayerColor, Point } from './types';
import { toPoint } from './types';
import { verifyWinningProof, type WinningProof } from './proof';
import { isProofGame, readProofBoard, winningCells } from './proofRules';

export interface StrategyCertificate {
  format: 'gomoku-proof-v1';
  rules: 'freestyle-15';
  game: GameState;
  attacker: PlayerColor;
  proof: WinningProof;
}
export interface WinningStrategy {
  moveFor(game: GameState): Point | null;
  proofFor(game: GameState): WinningProof | null;
  toJSON(): StrategyCertificate;
}

function isCertificate(value: unknown): value is StrategyCertificate {
  if (typeof value !== 'object' || value === null) return false;
  if (!('format' in value) || value.format !== 'gomoku-proof-v1') return false;
  if (!('rules' in value) || value.rules !== 'freestyle-15') return false;
  if (!('game' in value) || !isProofGame(value.game)) return false;
  if (!('attacker' in value) || (value.attacker !== 1 && value.attacker !== 2)) return false;
  return 'proof' in value && verifyWinningProof(value.game, value.attacker, value.proof);
}
function copyProof(proof: WinningProof): WinningProof {
  switch (proof.kind) {
    case 'five': return { kind: 'five', at: proof.at };
    case 'fork': return { kind: 'fork', at: proof.at };
    case 'force': return { kind: 'force', at: proof.at, reply: proof.reply, next: copyProof(proof.next) };
    case 'branch': return { kind: 'branch', at: proof.at,
      replies: proof.replies.map((reply) => ({ at: reply.at, proof: copyProof(reply.proof) })) };
  }
}
function copy(certificate: StrategyCertificate): StrategyCertificate {
  return { format: 'gomoku-proof-v1', rules: 'freestyle-15', attacker: certificate.attacker,
    game: { size: 15, board: certificate.game.board.map((row) => row.slice()),
      moves: certificate.game.moves.map((move) => ({ x: move.x, y: move.y, c: move.c })),
      over: false, winLine: null }, proof: copyProof(certificate.proof) };
}

class Strategy implements WinningStrategy {
  constructor(private readonly certificate: StrategyCertificate) {}
  toJSON(): StrategyCertificate { return copy(this.certificate); }
  moveFor(game: GameState): Point | null {
    const proof = this.findProof(game);
    return proof ? toPoint(proof.at) : null;
  }
  proofFor(game: GameState): WinningProof | null {
    const proof = this.findProof(game);
    return proof ? copyProof(proof) : null;
  }
  private findProof(game: GameState): WinningProof | null {
    const board = readProofBoard(game);
    if (!board || game.moves.length % 2 !== (this.certificate.attacker === 1 ? 0 : 1)) return null;
    const start = this.certificate.game.moves.length;
    if (game.moves.length < start) return null;
    const prefix = this.certificate.game.moves;
    if (!prefix.every((move, i) => move.x === game.moves[i]?.x && move.y === game.moves[i]?.y && move.c === game.moves[i]?.c)) return null;
    let proof = this.certificate.proof;
    for (let i = start; i < game.moves.length; i += 2) {
      const attack = game.moves[i];
      const reply = game.moves[i + 1];
      if (!attack || !reply || attack.y * 15 + attack.x !== proof.at) return null;
      const at = reply.y * 15 + reply.x;
      if (proof.kind === 'branch') {
        const child = proof.replies.find((item) => item.at === at);
        if (!child) return null;
        proof = child.proof;
      } else if (proof.kind === 'force' && proof.reply === at) proof = proof.next;
      else {
        if (i + 2 !== game.moves.length || proof.kind === 'five') return null;
        const win = winningCells(board, this.certificate.attacker)[0];
        return win === undefined ? null : { kind: 'five', at: win };
      }
    }
    return board[proof.at] === 0 ? proof : null;
  }
}
export function loadWinningStrategy(document: unknown): WinningStrategy | null {
  return isCertificate(document) ? new Strategy(copy(document)) : null;
}
