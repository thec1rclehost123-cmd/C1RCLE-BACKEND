import { getFirestoreClient } from '@c1rcle/core/infrastructure';

import { getGatewayConfig, GatewayConfigError } from '../../config/index.js';
import { createV2Services } from '../../lib/v2-services.js';
import authContextPlugin, { buildBetterAuth } from '../../plugins/auth.js';

import adminRoutes from './admin/onboarding-review.js';
import authRoutes from './auth/index.js';
import checkoutRoutes from './checkout/checkout-routes.js';
import paymentRoutes from './checkout/payment-routes.js';
import webhookRoutes from './checkout/webhook-routes.js';
import phase5CoverWalletRoutes from './door/cover-wallet-routes.js';
import phase5DoorSaleRoutes from './door/door-sale-routes.js';
import phase5ScannerRoutes from './door/scanner-routes.js';
import { internalRoutes } from './internal/index.js';
import onboardingRoutes from './onboarding.js';
import orderRoutes from './orders/orders-routes.js';
import partnerAnalyticsRoutes from './partner/analytics.js';
import partnerEventCatalogRoutes from './partner/event-catalog.js';
import partnerEventRoutes from './partner/events.js';
import partnerOrganizationRoutes from './partner/organizations.js';
import partnerPartnershipRoutes from './partner/partnerships.js';
import promoterConnectionRoutes from './partner/promoter-connections.js';
import partnerReferralLinkRoutes from './partner/referral-links.js';
import partnerVenueRoutes from './partner/venues.js';
import phase5Routes from './phase5-routes.js';
import publicDiscoveryRoutes from './public/discovery.js';
import ticketRoutes from './tickets/ticket-routes.js';
import walletRoutes from './wallet/wallet-routes.js';

import type { BetterAuthInstance } from '../../plugins/auth.js';
import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 route manifest ─────────────────────────────────────────────────────────
 * The single registration surface for all `/api/v2` routes. Phase 4's public
 * discovery slice (PR1, unauthenticated, under `/public`), checkout/
 * payments/webhook slice (PR2), and orders/tickets/wallet reads (PR3) are
 * all LIVE. Ticket transfer/claim/cancel-transfer stay unregistered — the
 * committed `Entitlement` model has no transfer state to wire against yet
 * (see `tickets/ticket-routes.ts`'s doc comment); they 404 by absence, never
 * by a 501 stub (D-006), same as any other genuinely-blocked slice.
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
      // Phase 4 PR1: unauthenticated guest-facing discovery reads — never
      // nested under the org-scoped/authenticated route group above.
      await v2.register(publicDiscoveryRoutes, { prefix: '/public' });
      await partnerOrganizationRoutes(v2);
      await partnerVenueRoutes(v2);
      await partnerEventRoutes(v2);
      await partnerEventCatalogRoutes(v2);
      await partnerPartnershipRoutes(v2);
      await partnerAnalyticsRoutes(v2);
      await partnerReferralLinkRoutes(v2);
      await promoterConnectionRoutes(v2);
      // Phase 2: not org-scoped — an applicant has no organization yet, and a
      // platform admin acts across all of them.
      await onboardingRoutes(v2);
      await adminRoutes(v2);
      // Phase 4 PR2: guest checkout + payments + Razorpay webhook.
      await checkoutRoutes(v2);
      await paymentRoutes(v2);
      await webhookRoutes(v2);
      // Phase 4 PR3: guest order/ticket reads + wallet.
      await orderRoutes(v2);
      await ticketRoutes(v2);
      await walletRoutes(v2);
      // Phase 5: Door / Scanner / Cover-wallet
      await phase5DoorSaleRoutes(v2);
      await phase5CoverWalletRoutes(v2);
      await phase5ScannerRoutes(v2);
      await phase5Routes(v2);
    },
    { prefix: '/api/v2' },
  );
}
