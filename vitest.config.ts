import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __LOBBY_ENABLED__: false },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/**', 'dist/**'],
  },
});
