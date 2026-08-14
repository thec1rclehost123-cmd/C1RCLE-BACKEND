import { getFirestoreClient } from '@c1rcle/core/infrastructure';

import { getGatewayConfig, GatewayConfigError } from '../../config/index.js';
import { createV2Services } from '../../lib/v2-services.js';
import authContextPlugin, { buildBetterAuth } from '../../plugins/auth.js';

import authRoutes from './auth/index.js';
import { internalRoutes } from './internal/index.js';
import partnerEventCatalogRoutes from './partner/event-catalog.js';
import partnerEventRoutes from './partner/events.js';
import partnerOrganizationRoutes from './partner/organizations.js';
import partnerPartnershipRoutes from './partner/partnerships.js';
import partnerVenueRoutes from './partner/venues.js';

import type { BetterAuthInstance } from '../../plugins/auth.js';
import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 route manifest ─────────────────────────────────────────────────────────
 * The single registration surface for all `/api/v2` routes. BLOCKED feature
 * slices (orders/checkout/payments/refunds/payouts/door/webhooks) must NOT be
 * registered here — they 404 by absence, never by a 501 stub.
 */
export async function registerV2Routes(app: FastifyInstance): Promise<void> {
  const gw = getGatewayConfig();
  const services = createV2Services();

  // B10: auth is only real on the firestore driver — see plugins/auth.ts and
  // docs/roadmap/phase-00-foundation.md for why the memory driver skips it.
  let auth: BetterAuthInstance | null = null;
  if (gw.STORAGE_DRIVER === 'firestore') {
    if (!gw.FIREBASE_CLIENT_EMAIL || !gw.FIREBASE_PRIVATE_KEY) {
      throw new GatewayConfigError(
        'STORAGE_DRIVER=firestore requires FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY',
      );
    }
    auth = buildBetterAuth(
      gw,
      getFirestoreClient({
        projectId: gw.FIRESTORE_PROJECT_ID,
        clientEmail: gw.FIREBASE_CLIENT_EMAIL,
        privateKey: gw.FIREBASE_PRIVATE_KEY,
      }),
    );
  }

  await app.register(authContextPlugin, {
    auth,
    organizations: services.repos().organizations,
  });

  // Path shape: nested org-scoped routes directly under `/api/v2` — no
  // `/partner` segment. Resolves docs/architecture/decisions.md open question #2 ("manifest
  // wins") and matches task.md §5 / docs/reference/frontend-api-map.md §2 exactly.
  // The route files themselves already declare paths like `/organizations`,
  // `/venues/:venueId`, `/events/:eventId` — removing the old `/partner`
  // wrapper is the entire fix, no path strings changed in the route files
  // beyond the events.ts org-scoping already done above.
  await app.register(
    async (v2) => {
      await internalRoutes(v2);
      await v2.register(async (a) => authRoutes(a, { auth }), { prefix: '/auth' });
      await partnerOrganizationRoutes(v2);
      await partnerVenueRoutes(v2);
      await partnerEventRoutes(v2);
      await partnerEventCatalogRoutes(v2);
      await partnerPartnershipRoutes(v2);
    },
    { prefix: '/api/v2' },
  );
}
