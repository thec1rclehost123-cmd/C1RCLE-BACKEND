import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMemoryRateLimitStore,
  createRedisRateLimitStore,
  type RateLimitBudget,
  type RateLimitStore,
} from './rate-limit-store.js';

const BUDGET: RateLimitBudget = { limit: 3, windowMs: 60_000 };

/** Behaviour every store must share, so memory and Redis cannot drift apart. */
function sharedContract(name: string, makeStore: () => Promise<RateLimitStore> | RateLimitStore) {
  describe(`${name} — sliding window contract`, () => {
    it('allows up to the limit then blocks, reporting when a slot frees', async () => {
      const store = await makeStore();
      const key = `k-${Math.random()}`;
      for (let i = 0; i < 3; i += 1) {
        expect((await store.hit(key, BUDGET, 1_000 + i)).allowed).toBe(true);
      }
      const blocked = await store.hit(key, BUDGET, 1_010);
      expect(blocked.allowed).toBe(false);
      // Oldest hit at t=1000 leaves the 60s window at t=61000.
      expect(blocked.retryAfterSeconds).toBe(60);
    });

    it('lets a caller back in once the window has slid past its hits', async () => {
      const store = await makeStore();
      const key = `k-${Math.random()}`;
      for (let i = 0; i < 3; i += 1) await store.hit(key, BUDGET, 1_000 + i);
      expect((await store.hit(key, BUDGET, 1_500)).allowed).toBe(false);
      expect((await store.hit(key, BUDGET, 62_000)).allowed).toBe(true);
    });

    it('does not let blocked attempts extend the penalty', async () => {
      const store = await makeStore();
      const key = `k-${Math.random()}`;
      for (let i = 0; i < 3; i += 1) await store.hit(key, BUDGET, 1_000 + i);
      for (let i = 0; i < 20; i += 1) await store.hit(key, BUDGET, 2_000 + i);
      // Only the three admitted hits count, so the window clears on schedule.
      expect((await store.hit(key, BUDGET, 61_500)).allowed).toBe(true);
    });

    it('keeps keys independent', async () => {
      const store = await makeStore();
      const a = `a-${Math.random()}`;
      const b = `b-${Math.random()}`;
      for (let i = 0; i < 3; i += 1) await store.hit(a, BUDGET, 1_000 + i);
      expect((await store.hit(a, BUDGET, 1_100)).allowed).toBe(false);
      expect((await store.hit(b, BUDGET, 1_100)).allowed).toBe(true);
    });
  });
}

sharedContract('memory store', () => createMemoryRateLimitStore());
sharedContract('redis store (ioredis-mock, Lua script)', () =>
  createRedisRateLimitStore(new RedisMock(), {
    fallback: createMemoryRateLimitStore(),
  }),
);

describe('redis store', () => {
  it('shares one window across instances, which per-process memory cannot', async () => {
    const shared = new RedisMock();
    const instanceA = createRedisRateLimitStore(shared, { fallback: createMemoryRateLimitStore() });
    const instanceB = createRedisRateLimitStore(shared, { fallback: createMemoryRateLimitStore() });

    for (let i = 0; i < 3; i += 1) {
      expect((await instanceA.hit('shared-key', BUDGET, 1_000 + i)).allowed).toBe(true);
    }
    // The budget was spent on instance A; instance B must see that.
    expect((await instanceB.hit('shared-key', BUDGET, 1_100)).allowed).toBe(false);

    // The same pair of in-memory stores would each grant a fresh budget.
    const memA = createMemoryRateLimitStore();
    const memB = createMemoryRateLimitStore();
    for (let i = 0; i < 3; i += 1) await memA.hit('shared-key', BUDGET, 1_000 + i);
    expect((await memB.hit('shared-key', BUDGET, 1_100)).allowed).toBe(true);
  });

  it('prefixes keys so it cannot collide with other users of the instance', async () => {
    const redis = new RedisMock();
    const store = createRedisRateLimitStore(redis, {
      keyPrefix: 'test:rl:',
      fallback: createMemoryRateLimitStore(),
    });
    await store.hit('who', BUDGET, 1_000);
    expect(await redis.exists('test:rl:who')).toBe(1);
    expect(await redis.exists('who')).toBe(0);
  });

  it('degrades to the in-memory fallback when Redis errors, and still enforces the limit', async () => {
    const broken = {
      eval: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as Redis;
    const onError = vi.fn();
    const store = createRedisRateLimitStore(broken, {
      fallback: createMemoryRateLimitStore(),
      onError,
    });

    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await store.hit('k', BUDGET, 1_000 + i));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('skips Redis during the cooldown so an outage costs one timeout, not one per request', async () => {
    const evalSpy = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const store = createRedisRateLimitStore({ eval: evalSpy } as unknown as Redis, {
      fallback: createMemoryRateLimitStore(),
      cooldownMs: 5_000,
    });

    await store.hit('k', BUDGET, 1_000);
    await store.hit('k', BUDGET, 2_000);
    await store.hit('k', BUDGET, 4_000);
    expect(evalSpy).toHaveBeenCalledTimes(1);

    // After the cooldown it tries Redis again.
    await store.hit('k', BUDGET, 7_000);
    expect(evalSpy).toHaveBeenCalledTimes(2);
  });
});

// Real-Redis check: the Lua script is the part a mock can mis-model, so when a
// Redis is available run the same contract against it.
//   REDIS_TEST_URL=redis://localhost:6379 pnpm --filter api-gateway test
// eslint-disable-next-line no-restricted-syntax -- test-only opt-in, not gateway configuration
const realRedisUrl: string | undefined = process.env.REDIS_TEST_URL;
describe.skipIf(!realRedisUrl)('redis store against a real Redis', () => {
  let client: Redis | undefined;
  afterEach(async () => {
    await client?.quit();
  });

  it('enforces the sliding window atomically', async () => {
    client = new Redis(realRedisUrl ?? '');
    const store = createRedisRateLimitStore(client, {
      keyPrefix: `c1rcle:test:${Date.now()}:`,
      fallback: createMemoryRateLimitStore(),
    });
    const key = 'real';
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => store.hit(key, BUDGET, now + i)),
    );
    // Concurrent hits must not race past the limit.
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });
});
