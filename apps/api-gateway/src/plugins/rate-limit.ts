import { buildV2ErrorResponse } from '@c1rcle/contracts';
import fp from 'fastify-plugin';

import { createMemoryRateLimitStore, type RateLimitStore } from '../lib/rate-limit-store.js';

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
 * Sliding window. The counters live in a `RateLimitStore`: process memory by
 * default, or Redis (`RATE_LIMIT_STORE=redis`) so the window is shared across
 * gateway instances and survives restarts. Classes and key shape are the same
 * either way.
 */

export type RateLimitClass =
  | 'PUBLIC_READ'
  | 'AUTH_READ'
  | 'STANDARD_COMMAND'
  | 'SENSITIVE_COMMAND'
  | 'OTP_SEND'
  | 'OTP_VERIFY'
  | 'SCANNER_COMMAND';

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
  // A busy club door genuinely scans faster than STANDARD_COMMAND's 60/min:
  // several devices, one verified operator, a queue moving at a few guests a
  // second. Throttling that would hold up a real line, so scanning gets its
  // own budget. It is still bounded — the door is not an unlimited write
  // surface — and admission itself is idempotent per ticket regardless.
  SCANNER_COMMAND: { limit: 300, windowMs: 60_000 },
};

export interface RateLimitOptions {
  now?: () => number;
  /** Disables enforcement (tests that are not about rate limiting). */
  enabled?: boolean;
  /** Counter storage. Defaults to per-process memory. */
  store?: RateLimitStore;
}

export default fp<RateLimitOptions>(
  async (fastify: FastifyInstance, options: RateLimitOptions) => {
    const now = options.now ?? (() => Date.now());
    const enabled = options.enabled ?? true;
    const store = options.store ?? createMemoryRateLimitStore();

    fastify.decorate('rateLimit', (limitClass: RateLimitClass) => {
      const budget = RATE_LIMIT_CLASSES[limitClass];

      return async (request: FastifyRequest, reply: FastifyReply) => {
        if (!enabled) return;

        const decision = await store.hit(compoundKey(request, limitClass), budget, now());

        if (!decision.allowed) {
          void reply
            .status(429)
            .header('retry-after', String(decision.retryAfterSeconds))
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
