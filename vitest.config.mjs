import { defineConfig } from 'vitest/config';

/**
 * ─── Root test runner: one pass, one coverage report ─────────────────────────
 * `turbo run test` executes each package's own `vitest run` in its own worker
 * pool, which is right for local iteration but produces three disjoint coverage
 * reports that cannot be merged meaningfully.
 *
 * This config runs the same three suites as vitest "projects" in a single
 * process, so `pnpm test:coverage` emits ONE `coverage/coverage-summary.json`
 * for the whole monorepo. Each project still loads its own
 * `vitest.config.mjs`, so per-package `env`, `testTimeout` and `hookTimeout`
 * are preserved exactly.
 *
 * Coverage is a root-only option in vitest — it is deliberately NOT set in the
 * per-package configs (where, being a sibling of `test`, it was silently
 * ignored anyway).
 */
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      // json-summary -> the ratchet script + PR comment; json -> per-file detail
      // in the PR comment; lcov -> any external viewer; text-summary -> logs.
      reporter: ['text-summary', 'json-summary', 'json', 'lcov'],
      // Report on all source, not just files a test happened to import —
      // otherwise adding an untested module silently raises the percentage.
      all: true,
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.integration.test.ts',
        '**/*.d.ts',
        '**/test-utils/**',
        '**/dist/**',
        '**/node_modules/**',
        // Entrypoints and wiring: exercised end-to-end, not unit-tested.
        'apps/*/src/server.ts',
        'apps/*/src/scripts/**',
      ],
      // No absolute thresholds here on purpose. CI enforces a *ratchet*
      // (scripts/ci/coverage-ratchet.mjs): coverage may never fall below the
      // last value recorded on the default branch. An absolute floor can be
      // layered on top by setting the COVERAGE_MIN_LINES repository variable.
    },
  },
});
