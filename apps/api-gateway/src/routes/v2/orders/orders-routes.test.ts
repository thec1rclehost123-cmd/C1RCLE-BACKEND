import { MemoryPaymentProvider } from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import checkoutRoutes from '../checkout/checkout-routes.js';
import paymentRoutes from '../checkout/payment-routes.js';
import partnerEventCatalogRoutes from '../partner/event-catalog.js';
import partnerEventRoutes from '../partner/events.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerVenueRoutes from '../partner/venues.js';

import orderRoutes from './orders-routes.js';

/**
 * ─── Guest order reads over HTTP (Phase 4 PR3) ──────────────────────────────
 * Seeds a fully paid order through the real checkout/payment routes (not a
 * repository backdoor), then asserts `orders-routes.ts` serves it back only
 * to its buyer.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerEventCatalogRoutes,
      checkoutRoutes,
      paymentRoutes,
      orderRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;

const write = (org: string) => ({
  'x-organization-id': org,
  'idempotency-key': `catalog-key-${++keySeq}`,
});

function memoryProvider(): MemoryPaymentProvider {
  const provider = createV2Services().paymentProvider;
  if (!(provider instanceof MemoryPaymentProvider)) {
    throw new Error('expected the memory payment provider under STORAGE_DRIVER=memory');
  }
  return provider;
}

/** Seeds org -> venue -> event -> tier -> hold -> paid order. Returns the order id. */
async function seedPaidOrder(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  const org: string = created.json().id;
  const venue = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
  });
  const venueId: string = venue.json().id;
  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: { title: 'Sky Night', venueId, startAt: '2026-09-01T18:00:00Z' },
  });
  const eventId: string = event.json().id;
  const tier = await server.inject({
    method: 'POST',
    url: `/events/${eventId}/ticket-tiers`,
    headers: write(org),
    payload: { name: 'General', priceInPaise: 150_000, quantity: 100 },
  });
  const tierId: string = tier.json().id;
  const hold = await server.inject({
    method: 'POST',
    url: '/checkout/holds',
    headers: { 'idempotency-key': `hold-${++keySeq}` },
    payload: { eventId, lines: [{ tierId, quantity: 1 }] },
  });
  const holdId: string = hold.json().holdId;
  const grandTotalPaise: number = hold.json().pricing.grandTotalPaise;
  const attempt = await server.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { 'idempotency-key': `attempt-${++keySeq}` },
    payload: { holdId },
  });
  const paymentIntentId: string = attempt.json().paymentIntentId;
  const paymentId = `pay_order_test_${++keySeq}`;
  const provider = memoryProvider();
  provider.simulateCapture(paymentId, grandTotalPaise);
  const signature = provider.generateSignature({ paymentId, orderId: paymentIntentId });
  const verify = await server.inject({
    method: 'POST',
    url: `/payments/${paymentId}/verify`,
    payload: { holdId, paymentIntentId, signature },
  });
  return verify.json().order.id as string;
}

describe('GET /orders/:id', () => {
  it("returns the buyer's own order", async () => {
    const server = await buildServer();
    const orderId = await seedPaidOrder(server);

    const response = await server.inject({ method: 'GET', url: `/orders/${orderId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: orderId, status: 'paid' });
    await server.close();
  });

  it('unknown order id -> 404 not_found', async () => {
    const server = await buildServer();

    const response = await server.inject({
      method: 'GET',
      url: '/orders/ORD-does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });

  it("another buyer's order id -> 404, never 403 (no existence oracle)", async () => {
    const server = await buildServer();
    const orderId = await seedPaidOrder(server);

    // The memory driver's fabricated actor defaults to a fixed `user_1` for
    // every unauthenticated request — force a different one via the header
    // fallback `actorFromRequest` reads (`v2-services.ts`).
    const response = await server.inject({
      method: 'GET',
      url: `/orders/${orderId}`,
      headers: { 'x-user-id': 'a-different-guest' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });
});

describe('GET /orders/:id/status', () => {
  it('returns the slim status projection', async () => {
    const server = await buildServer();
    const orderId = await seedPaidOrder(server);

    const response = await server.inject({ method: 'GET', url: `/orders/${orderId}/status` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: orderId, status: 'paid', version: 1 });
    await server.close();
  });
});

describe('GET /orders', () => {
  it("lists the buyer's own orders", async () => {
    const server = await buildServer();
    const orderId = await seedPaidOrder(server);

    const response = await server.inject({ method: 'GET', url: '/orders' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.some((o: { id: string }) => o.id === orderId)).toBe(true);
    expect(body.pageInfo.total).toBeGreaterThan(0);
    await server.close();
  });
});
