import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests touch the filesystem in tmp dirs; run sequentially for clarity
    // until we have isolated fixtures.
    pool: 'forks',
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
  },
});
