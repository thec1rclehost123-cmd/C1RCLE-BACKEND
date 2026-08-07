import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      REDIS_URL: 'PLACEHOLDER',
      FIRESTORE_PROJECT_ID: 'test-project',
    },
  },
  coverage: { provider: 'v8' },
});
