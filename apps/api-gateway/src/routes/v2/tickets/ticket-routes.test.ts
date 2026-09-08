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

import ticketRoutes from './ticket-routes.js';

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
      ticketRoutes,
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

/** Seeds org -> venue -> event -> tier -> hold -> paid order, returns its ticket id. */
async function seedTicket(server: Server): Promise<string> {
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
  const paymentId = `pay_ticket_test_${++keySeq}`;
  const provider = memoryProvider();
  provider.simulateCapture(paymentId, grandTotalPaise);
  const signature = provider.generateSignature({ paymentId, orderId: paymentIntentId });
  const verify = await server.inject({
    method: 'POST',
    url: `/payments/${paymentId}/verify`,
    payload: { holdId, paymentIntentId, signature },
  });
  return verify.json().entitlements[0].id as string;
}

describe('GET /tickets/:id', () => {
  it("returns the owner's ticket", async () => {
    const server = await buildServer();
    const ticketId = await seedTicket(server);

    const response = await server.inject({ method: 'GET', url: `/tickets/${ticketId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: ticketId, status: 'valid', scanCount: 0 });
    await server.close();
  });

  it('unknown ticket id -> 404 not_found', async () => {
    const server = await buildServer();

    const response = await server.inject({
      method: 'GET',
      url: '/tickets/ENT-does-not-exist-0',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });

  it("another guest's ticket id -> 404, never 403", async () => {
    const server = await buildServer();
    const ticketId = await seedTicket(server);

    const response = await server.inject({
      method: 'GET',
      url: `/tickets/${ticketId}`,
      headers: { 'x-user-id': 'a-different-guest' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });
});
