import { buildV2ErrorResponse } from '@c1rcle/contracts';
import fp from 'fastify-plugin';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── Rate limiting (B10 / T15) ───────────────────────────────────────────────
 * Ported from Sagar's parallel B10 work (origin/main 80cca2c) — this repo had
 * deferred rate limiting entirely; this plugin was more complete.
 *
 * Compound key: IP + user + organization. IP alone punishes everyone behind a
 * NAT and lets one account rotate addresses; user alone lets an anonymous
 * flood through. Both, plus tenant, so one noisy org cannot starve another.
 *
 * Sliding window, in-memory. A Redis-backed store can replace it later
 * without changing the classes or the key shape.
 */

export type RateLimitClass =
  | 'PUBLIC_READ'
  | 'AUTH_READ'
  | 'STANDARD_COMMAND'
  | 'SENSITIVE_COMMAND'
  | 'OTP_SEND'
  | 'OTP_VERIFY';

interface Budget {
  readonly limit: number;
  readonly windowMs: number;
}

export const RATE_LIMIT_CLASSES: Readonly<Record<RateLimitClass, Budget>> = {
  PUBLIC_READ: { limit: 120, windowMs: 60_000 },
  AUTH_READ: { limit: 240, windowMs: 60_000 },
  STANDARD_COMMAND: { limit: 60, windowMs: 60_000 },
  // Login/refresh: tight, because this is the credential-stuffing surface.
  SENSITIVE_COMMAND: { limit: 10, windowMs: 60_000 },
  // v1-proven thresholds (guest-otp.ts) — send is the enumeration/spam
  // surface (also blunts email-bombing), verify is the brute-force surface
  // (the domain's own 5-attempt lockout is the primary defense there; this
  // is the HTTP-layer backstop).
  OTP_SEND: { limit: 5, windowMs: 60_000 },
  OTP_VERIFY: { limit: 10, windowMs: 60_000 },
};

export interface RateLimitOptions {
  now?: () => number;
  /** Disables enforcement (tests that are not about rate limiting). */
  enabled?: boolean;
}

/**
 * Every route class here is reachable by an unauthenticated caller (OTP
 * send/verify, login, signup, public reads) — so the compound key is
 * attacker-controlled: a botnet rotating source IPs can mint effectively
 * unlimited distinct keys, each a permanent `Map` entry, since nothing
 * previously pruned a key once created. That is a memory-exhaustion DoS
 * available to anyone who can send HTTP requests, not just an authenticated
 * abuser. `MAX_TRACKED_KEYS` bounds the map's size; insertion order in a
 * `Map` iterates oldest-first, so evicting `hits.keys().next().value` evicts
 * the least-recently-touched key — an approximate LRU without a second
 * data structure, adequate for a sliding-window counter that is inherently
 * approximate already.
 */
const MAX_TRACKED_KEYS = 50_000;

export default fp<RateLimitOptions>(
  async (fastify: FastifyInstance, options: RateLimitOptions) => {
    const now = options.now ?? (() => Date.now());
    const enabled = options.enabled ?? true;
    /** key → hit timestamps inside the current window. Insertion order = LRU order. */
    const hits = new Map<string, number[]>();

    function touch(key: string, value: number[]): void {
      // Re-inserting (delete then set) moves the key to the "most recently
      // used" end of the Map's iteration order — otherwise a key hit once
      // long ago but never revisited would still occupy an early slot and
      // never get evicted ahead of one that just churned through its window.
      hits.delete(key);
      if (hits.size >= MAX_TRACKED_KEYS) {
        const oldestKey = hits.keys().next().value;
        if (oldestKey !== undefined) hits.delete(oldestKey);
      }
      hits.set(key, value);
    }

    fastify.decorate('rateLimit', (limitClass: RateLimitClass) => {
      const budget = RATE_LIMIT_CLASSES[limitClass];

      return async (request: FastifyRequest, reply: FastifyReply) => {
        if (!enabled) return;

        const key = compoundKey(request, limitClass);
        const current = now();
        const windowStart = current - budget.windowMs;

        const recent = (hits.get(key) ?? []).filter((stamp) => stamp > windowStart);

        if (recent.length >= budget.limit) {
          const oldest = recent[0] ?? current;
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((oldest + budget.windowMs - current) / 1000),
          );
          touch(key, recent);
          void reply
            .status(429)
            .header('retry-after', String(retryAfterSeconds))
            .send(
              buildV2ErrorResponse({
                status: 429,
                code: 'rate_limited',
                message: 'Too many requests',
                requestId: request.id,
              }),
            );
          return reply;
        }

        recent.push(current);
        touch(key, recent);
      };
    });

    fastify.log.info('V2 rate-limit plugin initialized');
  },
  { name: 'rate-limit-v2' },
);

/** IP + user + organization + class — one bucket per meaningful principal. */
function compoundKey(request: FastifyRequest, limitClass: RateLimitClass): string {
  const ip = request.ip || 'unknown-ip';
  const userId = request.authUser?.id ?? 'anonymous';
  const organizationId =
    request.actor?.organizationId ??
    (typeof request.headers['x-organization-id'] === 'string'
      ? request.headers['x-organization-id']
      : 'no-org');
  return `${limitClass}|${ip}|${userId}|${organizationId}`;
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimit: (
      limitClass: RateLimitClass,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}
