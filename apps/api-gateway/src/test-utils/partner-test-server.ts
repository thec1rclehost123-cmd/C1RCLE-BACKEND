import Fastify from 'fastify';

import type { OrganizationRole } from '@c1rcle/core/domain';

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
  /**
   * Fabricated membership role for the memory-driver actor (default `owner`,
   * what `actorFromRequest` falls back to without a session). Lets a route
   * suite exercise role-based RBAC — e.g. a read-only `member` — without a
   * real auth flow; `services.actor` reads `request.authContext` for role and
   * org, so the hook installs one from the test's own org header.
   */
  actorRole?: OrganizationRole;
}

export async function buildPartnerTestServer(
  options: PartnerTestServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  // Installed before any plugin registers so every child context inherits it.
  if (options.actorRole) {
    const role = options.actorRole;
    server.addHook('onRequest', async (request) => {
      const header = request.headers['x-organization-id'];
      request.authContext = {
        activeMembership: {
          organizationId: Array.isArray(header) ? (header[0] ?? '') : (header ?? ''),
          role,
          capabilities: [],
        },
      };
    });
  }
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
