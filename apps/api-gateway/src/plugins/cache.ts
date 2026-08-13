import fp from 'fastify-plugin';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── Response cache (B10 / T17) ──────────────────────────────────────────────
 * Ported from Sagar's parallel B10 work (origin/main 80cca2c) — this repo had
 * deferred a cache plugin entirely; this one was more complete.
 *
 * Deliberate TTLs, and nothing sensitive is ever stored.
 *
 * Two rules make this safe:
 *  1. **Every key is tenant-scoped.** The organization is taken from the
 *     verified actor, never from a header, so org A cannot be served org B's
 *     entry even by forging one.
 *  2. **`NO_STORE` classes are never written.** Anything carrying PII, money or
 *     a credential is excluded by class rather than by reviewer vigilance.
 *
 * In-memory for now; a Redis-backed store (private, per-tenant) can replace it
 * later without changing the classes or the key shape.
 */

export type CacheClass =
  'ORGANIZATION' | 'VENUE_PROFILE' | 'EVENT_PREVIEW' | 'AVAILABILITY' | 'NO_STORE';

export const CACHE_TTL_MS: Readonly<Record<CacheClass, number>> = {
  ORGANIZATION: 5 * 60_000,
  VENUE_PROFILE: 5 * 60_000,
  EVENT_PREVIEW: 60_000,
  AVAILABILITY: 30_000,
  NO_STORE: 0,
};

interface CacheEntry {
  readonly body: string;
  readonly status: number;
  readonly expiresAt: number;
}

export interface CacheOptions {
  now?: () => number;
  enabled?: boolean;
}

export default fp<CacheOptions>(
  async (fastify: FastifyInstance, options: CacheOptions) => {
    const now = options.now ?? (() => Date.now());
    const enabled = options.enabled ?? true;
    const entries = new Map<string, CacheEntry>();

    fastify.decorate('cached', (cacheClass: CacheClass) => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        // Sensitive classes are not cacheable at all — say so on the wire.
        if (!enabled || cacheClass === 'NO_STORE') {
          void reply.header('cache-control', 'no-store');
          return;
        }
        if (request.method !== 'GET') return;

        const key = cacheKey(request, cacheClass);
        const hit = entries.get(key);
        if (hit && hit.expiresAt > now()) {
          void reply
            .status(hit.status)
            .header('x-cache', 'HIT')
            .header('cache-control', 'private, max-age=0')
            .type('application/json')
            .send(hit.body);
          return reply;
        }
        if (hit) entries.delete(key);

        request.cacheKey = { key, cacheClass };
      };
    });

    fastify.addHook('onSend', async (request, reply, payload) => {
      const pending = request.cacheKey;
      if (pending === undefined) return payload;
      request.cacheKey = undefined;

      if (reply.statusCode === 200 && typeof payload === 'string') {
        entries.set(pending.key, {
          body: payload,
          status: reply.statusCode,
          expiresAt: now() + CACHE_TTL_MS[pending.cacheClass],
        });
        void reply.header('x-cache', 'MISS');
      }
      return payload;
    });

    fastify.log.info('V2 cache plugin initialized');
  },
  { name: 'cache-v2' },
);

/**
 * Tenant + actor + URL. The organization comes from the verified actor, so a
 * cache entry can never be addressed by a forged header.
 */
function cacheKey(request: FastifyRequest, cacheClass: CacheClass): string {
  const organizationId = request.actor?.organizationId ?? 'no-org';
  const userId = request.actor?.userId ?? 'anonymous';
  return `${cacheClass}|${organizationId}|${userId}|${request.url}`;
}

declare module 'fastify' {
  interface FastifyInstance {
    cached: (
      cacheClass: CacheClass,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }

  interface FastifyRequest {
    cacheKey?: { key: string; cacheClass: CacheClass };
  }
}
