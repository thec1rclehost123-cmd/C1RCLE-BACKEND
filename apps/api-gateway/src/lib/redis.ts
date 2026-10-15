import { Redis } from 'ioredis';

import type { ReadinessCheck } from '../routes/v2/route-manifest.js';

/**
 * One Redis client for the gateway, created only when something actually needs
 * it (`RATE_LIMIT_STORE=redis`). Tuned to fail fast: a slow or absent Redis must
 * cost a request milliseconds, never hang it, because every caller has an
 * in-memory fallback.
 *  - `enableOfflineQueue: false` — commands issued while disconnected reject
 *    immediately instead of piling up in memory;
 *  - `maxRetriesPerRequest: 1` and a short `commandTimeout` bound each call;
 *  - `retryStrategy` reconnects with capped backoff, so recovery is automatic.
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}

/** Readiness probe: a real round trip, not "the socket object exists". */
export function createRedisReadinessCheck(client: Redis): ReadinessCheck {
  return async () => (await client.ping()) === 'PONG';
}
