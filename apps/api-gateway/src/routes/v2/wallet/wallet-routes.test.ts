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

import walletRoutes from './wallet-routes.js';

/**
 * ─── Guest wallet over HTTP (Phase 4 PR3) ───────────────────────────────────
 * `createV2Services()` is a module-scoped singleton shared by every test in
 * this file (by design — routes and this test file must see the same
 * repositories). That means state accumulates ACROSS tests, so each test
 * uses its own `x-user-id` guest actor rather than assuming a pristine
 * repository — the memory driver's actor-fabrication fallback reads that
 * header (`v2-services.ts`), so a distinct id gets a genuinely isolated view.
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
      walletRoutes,
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

/** Seeds org -> venue -> event -> tier -> hold -> paid order (one ticket) for one guest. */
async function seedPaidOrder(server: Server, guestUserId: string): Promise<void> {
  const guest = { 'x-user-id': guestUserId };
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
    headers: { ...guest, 'idempotency-key': `hold-${++keySeq}` },
    payload: { eventId, lines: [{ tierId, quantity: 1 }] },
  });
  const holdId: string = hold.json().holdId;
  const grandTotalPaise: number = hold.json().pricing.grandTotalPaise;
  const attempt = await server.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { ...guest, 'idempotency-key': `attempt-${++keySeq}` },
    payload: { holdId },
  });
  const paymentIntentId: string = attempt.json().paymentIntentId;
  const paymentId = `pay_wallet_test_${++keySeq}`;
  const provider = memoryProvider();
  provider.simulateCapture(paymentId, grandTotalPaise);
  const signature = provider.generateSignature({ paymentId, orderId: paymentIntentId });
  await server.inject({
    method: 'POST',
    url: `/payments/${paymentId}/verify`,
    headers: guest,
    payload: { holdId, paymentIntentId, signature },
  });
}

describe('GET /wallet', () => {
  it('summarizes active tickets and paid orders for the caller only', async () => {
    const server = await buildServer();
    await seedPaidOrder(server, 'wallet-guest-1');

    const response = await server.inject({
      method: 'GET',
      url: '/wallet',
      headers: { 'x-user-id': 'wallet-guest-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ activeTicketCount: 1, upcomingOrderCount: 1 });
    await server.close();
  });

  it('a guest with nothing yet sees zeros, not an error', async () => {
    const server = await buildServer();
    // Another guest has already bought a ticket in this shared-services test
    // run (previous test) — proves the summary is scoped per caller, not a
    // process-wide count.
    await seedPaidOrder(server, 'wallet-guest-busy');

    const response = await server.inject({
      method: 'GET',
      url: '/wallet',
      headers: { 'x-user-id': 'wallet-guest-empty' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ activeTicketCount: 0, upcomingOrderCount: 0 });
    await server.close();
  });
});

describe('GET /wallet/tickets', () => {
  it('lists only the caller-own paid ticket', async () => {
    const server = await buildServer();
    await seedPaidOrder(server, 'wallet-guest-tickets');

    const response = await server.inject({
      method: 'GET',
      url: '/wallet/tickets',
      headers: { 'x-user-id': 'wallet-guest-tickets' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0]).toMatchObject({ status: 'valid' });
    await server.close();
  });
});

describe('GET /wallet/orders', () => {
  it('lists only the caller-own paid order', async () => {
    const server = await buildServer();
    await seedPaidOrder(server, 'wallet-guest-orders');

    const response = await server.inject({
      method: 'GET',
      url: '/wallet/orders',
      headers: { 'x-user-id': 'wallet-guest-orders' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0]).toMatchObject({ status: 'paid' });
    await server.close();
  });
});
