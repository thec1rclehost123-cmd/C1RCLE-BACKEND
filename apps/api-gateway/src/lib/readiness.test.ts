import { describe, expect, it } from 'vitest';

import { getGatewayConfig } from '../config/index.js';

import { createReadinessChecks } from './readiness.js';

function testConfig(overrides: Record<string, string> = {}) {
  return getGatewayConfig({
    NODE_ENV: 'test',
    STORAGE_DRIVER: 'memory',
    TRUSTED_PROXY_CIDRS: '127.0.0.1',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
    ...overrides,
  });
}

describe('dependency readiness', () => {
  it('does not invent external checks for the memory driver', () => {
    expect(createReadinessChecks(testConfig())).toEqual({});
  });

  it('supports bounded, injected Redis and payment checks', async () => {
    const checks = createReadinessChecks(testConfig(), {
      redisCheck: () => true,
      paymentProviderActive: true,
    });

    expect(await checks.redis?.()).toBe(true);
    expect(await checks.paymentProvider?.()).toBe(false);
  });

  it('times out an injected dependency check', async () => {
    const checks = createReadinessChecks(testConfig(), {
      redisCheck: () => new Promise<boolean>(() => {}),
      timeoutMs: 1,
    });

    await expect(checks.redis?.()).resolves.toBe(false);
  });

  it('registers Firestore and Storage probes without running them at bootstrap', () => {
    const config = testConfig({
      STORAGE_DRIVER: 'firestore',
      FIREBASE_CLIENT_EMAIL: 'staging@example.test',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nstaging\\n-----END PRIVATE KEY-----',
    });

    expect(Object.keys(createReadinessChecks(config))).toEqual(['firestore', 'storage']);
  });
});
