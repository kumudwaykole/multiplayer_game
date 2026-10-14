import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/globalSetup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          // Tests share one database container; run files one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
