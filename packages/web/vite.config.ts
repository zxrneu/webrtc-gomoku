import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
import fs from 'node:fs';
import { loadTlsOptions } from '../../tooling/tls.mjs';

export default defineConfig(({ mode, command }) => ({
  define: { __LOBBY_ENABLED__: mode !== 'standalone' },
  plugins: [
    react(),
    viteSingleFile(),
    {
      name: 'copy-standalone-html',
      closeBundle() {
        if (mode !== 'standalone') return;
        const outDir = path.resolve(__dirname, 'dist-standalone');
        const srcFile = path.join(outDir, 'index.html');
        const rootDistDir = path.resolve(__dirname, '../../dist');
        const targetFile = path.join(rootDistDir, 'gomoku-standalone.html');

        if (fs.existsSync(srcFile)) {
          fs.mkdirSync(rootDistDir, { recursive: true });
          fs.copyFileSync(srcFile, targetFile);
          console.log(`[copy-standalone-html] Copied ${srcFile} to ${targetFile}`);
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@webrtc-gomoku/core': path.resolve(__dirname, '../core/src'),
      '@webrtc-gomoku/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    https: command === 'serve' ? loadTlsOptions(process.env, path.resolve(__dirname, '../..')) : undefined,
    port: 5173,
    proxy: {
      '/signal': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/config': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
  build: {
    outDir: mode === 'standalone' ? 'dist-standalone' : 'dist',
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 10000,
    cssCodeSplit: false,
    emptyOutDir: true,
  },
}));
