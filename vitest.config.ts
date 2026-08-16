import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/web/**'],
    },
  },
  resolve: {
    alias: {
      '@unmarkk/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
});
