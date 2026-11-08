import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

/**
 * ─── Rate-limit storage ──────────────────────────────────────────────────────
 * The sliding-window counter behind `plugins/rate-limit.ts`, split from the
 * plugin so the same budgets can be enforced from process memory or from Redis.
 *
 * Memory is per instance and resets on restart: with N gateway instances an
 * attacker gets N × the budget, and every deploy hands everyone a fresh one.
 * Redis shares the window across instances and survives restarts.
 */

export interface RateLimitBudget {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until a slot frees up; meaningful only when `allowed` is false. */
  readonly retryAfterSeconds: number;
}

export interface RateLimitStore {
  hit(key: string, budget: RateLimitBudget, nowMs: number): Promise<RateLimitDecision>;
}

/**
 * Every rate-limited route is reachable by an unauthenticated caller, so the
 * compound key is attacker-controlled: rotating source IPs mints unlimited
 * distinct keys. Bounding the map stops that being a memory-exhaustion DoS;
 * `Map` iterates oldest-first, so evicting the first key is an approximate LRU.
 */
const MAX_TRACKED_KEYS = 50_000;

export function createMemoryRateLimitStore(): RateLimitStore {
  /** key → hit timestamps inside the current window. Insertion order = LRU order. */
  const hits = new Map<string, number[]>();

  function touch(key: string, value: number[]): void {
    // Delete-then-set moves the key to the "most recently used" end.
    hits.delete(key);
    if (hits.size >= MAX_TRACKED_KEYS) {
      const oldestKey = hits.keys().next().value;
      if (oldestKey !== undefined) hits.delete(oldestKey);
    }
    hits.set(key, value);
  }

  return {
    hit(key, budget, nowMs) {
      const windowStart = nowMs - budget.windowMs;
      const recent = (hits.get(key) ?? []).filter((stamp) => stamp > windowStart);

      if (recent.length >= budget.limit) {
        const oldest = recent[0] ?? nowMs;
        touch(key, recent);
        return Promise.resolve({
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + budget.windowMs - nowMs) / 1000)),
        });
      }

      recent.push(nowMs);
      touch(key, recent);
      return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
    },
  };
}

/**
 * Atomic sliding window on a sorted set (score = hit time). One round trip, and
 * no read-then-write race between concurrent requests or instances.
 * Returns {allowed(1|0), retryAfterMs}.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  return {0, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, 0}
`;

export interface RedisRateLimitStoreOptions {
  /** Prefix for every key, so the gateway's counters never collide with other users of the instance. */
  keyPrefix?: string;
  /** Used while Redis is unreachable. Failing open to per-instance limits beats failing every login. */
  fallback: RateLimitStore;
  /** How long to skip Redis after an error, so an outage costs one timeout, not one per request. */
  cooldownMs?: number;
  onError?: (error: unknown) => void;
}

export function createRedisRateLimitStore(
  redis: Redis,
  options: RedisRateLimitStoreOptions,
): RateLimitStore {
  const prefix = options.keyPrefix ?? 'c1rcle:ratelimit:';
  const cooldownMs = options.cooldownMs ?? 5_000;
  let skipRedisUntil = 0;

  return {
    async hit(key, budget, nowMs) {
      if (nowMs < skipRedisUntil) return options.fallback.hit(key, budget, nowMs);
      try {
        const result = (await redis.eval(
          SLIDING_WINDOW_SCRIPT,
          1,
          `${prefix}${key}`,
          String(nowMs),
          String(budget.windowMs),
          String(budget.limit),
          `${nowMs}-${randomUUID()}`,
        )) as [number, number];
        return {
          allowed: result[0] === 1,
          retryAfterSeconds: result[0] === 1 ? 0 : Math.max(1, Math.ceil(result[1] / 1000)),
        };
      } catch (error) {
        skipRedisUntil = nowMs + cooldownMs;
        options.onError?.(error);
        return options.fallback.hit(key, budget, nowMs);
      }
    },
  };
}
