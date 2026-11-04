import { afterEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => vi.useRealTimers());

  it('shares unfinished probes across concurrent requests and timeout retries', async () => {
    vi.useFakeTimers();
    let finish!: (ready: boolean) => void;
    const dependency = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const check = createReadinessChecks(testConfig(), {
      redisCheck: dependency,
      timeoutMs: 10,
    }).redis;
    if (!check) throw new Error('Redis readiness check missing');

    const first = check();
    const concurrent = check();
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toBe(false);
    expect(await concurrent).toBe(false);
    expect(dependency).toHaveBeenCalledTimes(1);

    const retry = check();
    await vi.advanceTimersByTimeAsync(10);
    expect(await retry).toBe(false);
    expect(dependency).toHaveBeenCalledTimes(1);

    // Late success must not become a cached green response for future probes.
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    dependency.mockResolvedValue(false);
    expect(await check()).toBe(false);
    expect(dependency).toHaveBeenCalledTimes(2);
  });

  it('allows a fresh check after a rejected dependency call', async () => {
    const dependency = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(true);
    const check = createReadinessChecks(testConfig(), { redisCheck: dependency }).redis;
    if (!check) throw new Error('Redis readiness check missing');
    await expect(check()).rejects.toThrow('unavailable');
    await expect(check()).resolves.toBe(true);
    expect(dependency).toHaveBeenCalledTimes(2);
  });

  it('allows a fresh check after a synchronous dependency failure', async () => {
    const dependency = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('initialization failed');
      })
      .mockReturnValue(true);
    const check = createReadinessChecks(testConfig(), { redisCheck: dependency }).redis;
    if (!check) throw new Error('Redis readiness check missing');
    await expect(check()).rejects.toThrow('initialization failed');
    await expect(check()).resolves.toBe(true);
  });

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
