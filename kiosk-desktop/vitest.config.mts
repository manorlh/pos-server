import { defineConfig } from 'vitest/config';
import { sharedAlias } from './vite.config.mts';

export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
  },
});
