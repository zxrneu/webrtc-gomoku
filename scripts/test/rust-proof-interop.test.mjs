import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWinningStrategy } from '../../packages/core/src/ai/strategy.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = path.join(root, 'crates/gomoku-solver/Cargo.toml');
function rust(...args) {
  return execFileSync('cargo', ['run', '--quiet', '--locked', '--offline', '--manifest-path', manifest, '--', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
}

describe('Rust / TypeScript independent proof verification', () => {
  it('TypeScript verifies a newly generated Rust proof covering every defense', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gomoku-proof-interop-'));
    try {
      const input = path.join(directory, 'input.json');
      const proof = path.join(directory, 'proof.json');
      const tree = path.join(directory, 'tree.json');
      fs.writeFileSync(input, JSON.stringify({
        moves: [[5, 7], [0, 0], [6, 7], [0, 2], [7, 5], [14, 14], [7, 6], [14, 12]],
        options: { maxAttacks: 3, maxNodes: 4000 },
      }));
      expect(JSON.parse(rust('solve', input, proof)).verified).toBe(true);
      rust('export', proof, tree);
      const certificate = JSON.parse(fs.readFileSync(tree, 'utf8'));
      expect(certificate.proof.replies).toHaveLength(216);
      expect(loadWinningStrategy(certificate)).not.toBeNull();
      certificate.proof.replies.pop();
      expect(loadWinningStrategy(certificate)).toBeNull();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('Rust independently verifies the existing TypeScript certificate', () => {
    const result = JSON.parse(rust('verify', path.join(root, 'docs/m5-ai/examples/double-three.proof.json')));
    expect(result).toEqual({ verified: true, guaranteedFirstPlayerWin: false });
  });

  it('TypeScript verifies the tree exported from a shared tactical DAG', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gomoku-tactical-interop-'));
    try {
      const input = path.join(directory, 'input.json');
      const proof = path.join(directory, 'proof.json');
      const tree = path.join(directory, 'tree.json');
      fs.writeFileSync(input, JSON.stringify({
        moves: [[5, 7], [0, 0], [6, 7], [0, 2], [7, 5], [14, 14], [7, 6], [14, 12]],
        options: { maxAttacks: 3, maxNodes: 0, tactics: { maxAttacks: 3, maxNodes: 4000, threes: true } },
      }));
      expect(JSON.parse(rust('solve', input, proof)).verified).toBe(true);
      expect(JSON.parse(fs.readFileSync(proof, 'utf8')).nodes.length).toBeLessThan(10);
      rust('export', proof, tree);
      const certificate = JSON.parse(fs.readFileSync(tree, 'utf8'));
      expect(certificate.proof.replies).toHaveLength(216);
      expect(loadWinningStrategy(certificate)).not.toBeNull();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
