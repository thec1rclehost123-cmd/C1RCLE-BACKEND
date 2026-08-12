import { buildV2ErrorResponse } from '@c1rcle/contracts';
import fp from 'fastify-plugin';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── Rate limiting (B10 / T15) ───────────────────────────────────────────────
 *
 * Compound key: IP + user + organization. IP alone punishes everyone behind a
 * NAT and lets one account rotate addresses; user alone lets an anonymous
 * flood through. Both, plus tenant, so one noisy org cannot starve another.
 *
 * Sliding window, in-memory. Redis replaces the store at B12 — the classes and
 * the key shape do not change.
 */

export type RateLimitClass = 'PUBLIC_READ' | 'AUTH_READ' | 'STANDARD_COMMAND' | 'SENSITIVE_COMMAND';

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
};

export interface RateLimitOptions {
  now?: () => number;
  /** Disables enforcement (tests that are not about rate limiting). */
  enabled?: boolean;
}

export default fp<RateLimitOptions>(
  async (fastify: FastifyInstance, options: RateLimitOptions) => {
    const now = options.now ?? (() => Date.now());
    const enabled = options.enabled ?? true;
    /** key → hit timestamps inside the current window. */
    const hits = new Map<string, number[]>();

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
          hits.set(key, recent);
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
        hits.set(key, recent);
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
