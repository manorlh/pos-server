import { defineConfig } from 'vitest/config';
import { sharedAlias, sharedDedupe } from './vite.config.mts';

export default defineConfig({
  // As the renderer's build: the shared screens' imports resolve to this package's React (their hooks render here).
  resolve: { alias: sharedAlias, dedupe: sharedDedupe },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
  },
});
