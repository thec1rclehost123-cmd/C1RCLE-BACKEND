import { defineConfig } from 'vitest/config';

/**
 * Scenario suite runner (main-gated extra hard gate).
 * Runs only the end-to-end scenario files under the `scenarios/` directory
 * (glob of `scenarios` + any `.test.ts` files beneath), NOT the regular
 * `src/` unit suite (that stays on the `test` task). Same env basis as
 * `vitest.config.mjs` so the memory driver, webhook HMAC secret, and actor
 * fabrication behave identically.
 */
export default defineConfig({
  test: {
    include: ['scenarios/**/*.test.ts'],
    env: {
      REDIS_URL: 'PLACEHOLDER',
      FIRESTORE_PROJECT_ID: 'test-project',
      // The webhook route reads this directly and fails closed (503) without
      // it — fixed so the scenario's HMAC can be computed the same way
      // `MemoryPaymentProvider` does (see vitest.config.mjs's comment).
      RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
      // Quiet the full-app build (buildApp registers real plugins).
      LOG_LEVEL: 'silent',
    },
    // buildApp registers every v2 route + plugins per test; on a cold first
    // run the worker pool is oversubscribed, so keep the same generous
    // ceilings the main suite uses.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
