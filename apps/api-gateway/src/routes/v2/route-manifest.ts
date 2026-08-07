import { internalRoutes } from './internal/index.js';
import partnerEventRoutes from './partner/events.js';
import partnerOrganizationRoutes from './partner/organizations.js';
import partnerVenueRoutes from './partner/venues.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 route manifest ─────────────────────────────────────────────────────────
 * The single registration surface for all `/api/v2` routes. BLOCKED feature
 * slices (orders/checkout/payments/refunds/payouts/door/webhooks) must NOT be
 * registered here — they 404 by absence, never by a 501 stub.
 */
export async function registerV2Routes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (v2) => {
      await internalRoutes(v2);
      // TODO(B10): auth routes (login/refresh/logout/session)
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
