import Fastify from 'fastify';

import { createV2Services } from '../lib/v2-services.js';
import cachePlugin from '../plugins/cache.js';
import rateLimitPlugin from '../plugins/rate-limit.js';
import rbacPlugin from '../plugins/rbac.js';
import validateV2Plugin from '../plugins/validate-v2.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Partner-route test server (test double — rule 10: only under test-utils) ─
 *
 * Partner routes declare policy preHandlers (`rateLimit`, `requirePermission`,
 * `cached`), so those decorators must exist or route *registration* fails —
 * which surfaces as an opaque "X is not a function" rather than a test
 * assertion. One builder keeps every suite consistent about that.
 *
 * Throttling and caching are off by default: a suite asserting validation or
 * idempotency should not start failing because it made 11 requests, and a
 * cached read would mask the very freshness these suites check. Suites that
 * are *about* those behaviours turn them on explicitly.
 */
export interface PartnerTestServerOptions {
  /** Route plugins to register (e.g. `partnerVenueRoutes`). */
  routes: ((fastify: FastifyInstance) => Promise<void>)[];
  rateLimit?: boolean;
  cache?: boolean;
}

export async function buildPartnerTestServer(
  options: PartnerTestServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await server.register(validateV2Plugin);
  await server.register(rateLimitPlugin, { enabled: options.rateLimit ?? false });
  // RBAC resolves identity through the same resolver the routes use, so policy
  // is evaluated against exactly the actor the service will act as.
  const services = createV2Services();
  await server.register(rbacPlugin, { resolveActor: (request) => services.actor(request) });
  await server.register(cachePlugin, { enabled: options.cache ?? false });
  for (const route of options.routes) {
    await server.register(route);
  }
  return server;
}
