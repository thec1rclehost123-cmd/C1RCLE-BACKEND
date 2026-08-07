import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['src/**/*.test.ts'],
    env: {
      REDIS_URL: 'PLACEHOLDER',
      FIRESTORE_PROJECT_ID: 'test-project',
    },
  },
  coverage: { provider: 'v8' },
});
