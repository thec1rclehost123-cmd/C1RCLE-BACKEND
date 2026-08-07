import { internalRoutes } from './internal/index.js';

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
      // TODO(B11): organizations/venues/events route modules
    },
    { prefix: '/api/v2' },
  );
}
