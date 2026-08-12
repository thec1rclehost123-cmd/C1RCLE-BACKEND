import authRoutes from './auth.js';
import { internalRoutes } from './internal/index.js';
import partnerEventRoutes from './partner/events.js';
import partnerOrganizationRoutes from './partner/organizations.js';
import partnerVenueRoutes from './partner/venues.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 route manifest (T14) ─────────────────────────────────────────────────
 *
 * Routes are DECLARED here once and registered from the declaration, so the
 * live surface cannot drift from the documented one — `route-manifest.test.ts`
 * diffs this table against what Fastify actually registered, in both
 * directions.
 *
 * BLOCKED slices (checkout, orders, payments, refunds, payouts, door,
 * webhooks, admin, public discovery) are absent rather than stubbed: they 404
 * by absence, never by a 501 that implies "coming soon" to a caller.
 */

export type V2RouteStatus = 'ACTIVE' | 'BLOCKED';

export interface V2ManifestEntry {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path as Fastify registers it, including the `/api/v2` prefix. */
  readonly path: string;
  readonly status: V2RouteStatus;
  readonly auth: 'PUBLIC' | 'PARTNER' | 'INTERNAL';
  readonly idempotency: 'NONE' | 'REQUIRED';
  readonly expectedVersion: 'NONE' | 'REQUIRED';
}

const PREFIX = '/api/v2';

/** Everything the gateway serves today. */
export const V2_ROUTE_MANIFEST: readonly V2ManifestEntry[] = [
  // Internal probes — no auth, no tenant.
  entry('internal.health', 'GET', '/internal/health', { auth: 'INTERNAL' }),
  entry('internal.version', 'GET', '/internal/version', { auth: 'INTERNAL' }),
  entry('internal.readiness', 'GET', '/internal/readiness', { auth: 'INTERNAL' }),

  // Auth — public by necessity: these are how a caller becomes authenticated.
  entry('auth.sign-up', 'POST', '/auth/sign-up', { auth: 'PUBLIC' }),
  entry('auth.login', 'POST', '/auth/login', { auth: 'PUBLIC' }),
  entry('auth.refresh', 'POST', '/auth/refresh', { auth: 'PUBLIC' }),
  entry('auth.logout', 'POST', '/auth/logout', { auth: 'PUBLIC' }),
  entry('auth.session', 'GET', '/auth/session', { auth: 'PUBLIC' }),

  // Organizations
  entry('organizations.list', 'GET', '/partner/organizations'),
  entry('organizations.create', 'POST', '/partner/organizations', { idempotency: 'REQUIRED' }),
  entry('organizations.get', 'GET', '/partner/organizations/:organizationId'),
  entry('organizations.update', 'PATCH', '/partner/organizations/:organizationId', {
    idempotency: 'REQUIRED',
    expectedVersion: 'REQUIRED',
  }),
  entry('organization-members.list', 'GET', '/partner/organizations/:organizationId/members'),
  entry('organization-members.invite', 'POST', '/partner/organizations/:organizationId/members', {
    idempotency: 'REQUIRED',
  }),

  // Venues
  entry('venues.list', 'GET', '/partner/organizations/:organizationId/venues'),
  entry('venues.create', 'POST', '/partner/organizations/:organizationId/venues', {
    idempotency: 'REQUIRED',
  }),
  entry('venues.get', 'GET', '/partner/venues/:venueId'),
  entry('venues.update', 'PATCH', '/partner/venues/:venueId', {
    idempotency: 'REQUIRED',
    expectedVersion: 'REQUIRED',
  }),
  entry('venue-profile.get', 'GET', '/partner/venues/:venueId/profile'),
  entry('venue-slot-requests.list', 'GET', '/partner/venues/:venueId/slot-requests'),
  entry('venue-slot-requests.create', 'POST', '/partner/venues/:venueId/slot-requests', {
    idempotency: 'REQUIRED',
  }),

  // Events
  entry('events.list', 'GET', '/partner/events'),
  entry('events.create', 'POST', '/partner/events', { idempotency: 'REQUIRED' }),
  entry('events.get', 'GET', '/partner/events/:eventId'),
  entry('events.previews', 'GET', '/partner/events/:eventId/previews'),
  ...(['review', 'publish', 'pause-sales', 'resume-sales', 'cancel'] as const).map((action) =>
    entry(`events.${action}`, 'POST', `/partner/events/:eventId/${action}`, {
      idempotency: 'REQUIRED',
      expectedVersion: 'REQUIRED',
    }),
  ),
  entry('events.duplicate', 'POST', '/partner/events/:eventId/duplicate', {
    idempotency: 'REQUIRED',
  }),
];

/**
 * Paths that must NOT exist. The test asserts each 404s — proof that a blocked
 * slice is absent rather than half-built behind a stub.
 */
export const BLOCKED_PATHS: readonly string[] = [
  '/api/v2/checkout',
  '/api/v2/orders',
  '/api/v2/payments',
  '/api/v2/refunds',
  '/api/v2/payouts',
  '/api/v2/bank-accounts',
  '/api/v2/door/scan',
  '/api/v2/webhooks/payments',
  '/api/v2/admin/organizations',
  '/api/v2/public/events',
];

function entry(
  id: string,
  method: V2ManifestEntry['method'],
  path: string,
  overrides: Partial<Omit<V2ManifestEntry, 'id' | 'method' | 'path'>> = {},
): V2ManifestEntry {
  return {
    id,
    method,
    path: `${PREFIX}${path}`,
    status: 'ACTIVE',
    auth: 'PARTNER',
    idempotency: 'NONE',
    expectedVersion: 'NONE',
    ...overrides,
  };
}

export async function registerV2Routes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (v2) => {
      await internalRoutes(v2);
      await authRoutes(v2);
      await v2.register(
        async (partner) => {
          await partnerOrganizationRoutes(partner);
          await partnerVenueRoutes(partner);
          await partnerEventRoutes(partner);
        },
        { prefix: '/partner' },
      );
    },
    { prefix: '/api/v2' },
  );
}
