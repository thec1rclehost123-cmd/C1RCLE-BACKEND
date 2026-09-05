import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      REDIS_URL: 'PLACEHOLDER',
      FIRESTORE_PROJECT_ID: 'test-project',
      // Phase 4 PR2: the webhook route reads this directly (never the
      // provider's own fallback — see webhook-routes.ts's doc comment) and
      // fails closed (503) without it. Fixed so webhook signature tests can
      // compute a valid HMAC the same way `MemoryPaymentProvider` does.
      RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
    },
    // Each route test builds a full Fastify app (validate + rbac + rate-limit +
    // cache plugins + routes). `pnpm check` runs this suite via `turbo run test`
    // alongside the core and contracts suites, so on a cold first run the box is
    // oversubscribed (three vitest worker pools) and app construction can stall
    // past vitest's 5s default — a flaky ~10 timeouts, always green in isolation.
    // The tests do ~150ms of real work; these ceilings just absorb the contention.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
