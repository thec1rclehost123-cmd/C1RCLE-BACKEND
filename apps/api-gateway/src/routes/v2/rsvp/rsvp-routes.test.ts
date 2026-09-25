import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import partnerEventCatalogRoutes from '../partner/event-catalog.js';
import partnerEventRoutes from '../partner/events.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerVenueRoutes from '../partner/venues.js';

import rsvpRoutes from './rsvp-routes.js';

/**
 * ─── RSVP over HTTP ──────────────────────────────────────────────────────────
 * `POST /rsvp` fulfills a free ticket directly: no quote, no hold, no
 * Razorpay. Asserts the transport contract plus the slice's own rules:
 * free-event + zero-price-tier eligibility, one RSVP per user per event
 * (409 on repeat), per-account scope (a second user succeeds), and inventory
 * exhaustion on the last ticket.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerEventCatalogRoutes,
      rsvpRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;

const write = (org: string) => ({
  'x-organization-id': org,
  'idempotency-key': `rsvp-key-${++keySeq}`,
});

/** Creates org → venue → event → one ticket tier; publishes the event. */
async function seed(
  server: Server,
  options: { priceInPaise?: number; quantity?: number; isFree?: boolean } = {},
): Promise<{ org: string; eventId: string; tierId: string }> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  expect(created.statusCode).toBe(201);
  const org: string = created.json().id;

  const venue = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
  });
  expect(venue.statusCode).toBe(201);
  const venueId: string = venue.json().id;

  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: { title: 'Free Night', venueId, startAt: '2026-09-01T18:00:00Z' },
  });
  expect(event.statusCode).toBe(201);
  const eventId: string = event.json().id;
  // New events default to `isFree: true`; the paid-event case flips it.
  if (options.isFree === false) {
    const updated = await server.inject({
      method: 'PATCH',
      url: `/events/${eventId}`,
      headers: { ...write(org), 'if-match': '1' },
      payload: { isFree: false },
    });
    expect(updated.statusCode).toBe(200);
  }

  const tier = await server.inject({
    method: 'POST',
    url: `/events/${eventId}/ticket-tiers`,
    headers: write(org),
    payload: {
      name: 'RSVP',
      priceInPaise: options.priceInPaise ?? 0,
      quantity: options.quantity ?? 100,
    },
  });
  expect(tier.statusCode).toBe(201);
  const tierId: string = tier.json().id;

  for (const action of ['review', 'publish']) {
    const transition = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/${action}`,
      headers: write(org),
    });
    expect(transition.statusCode).toBe(200);
  }

  return { org, eventId, tierId };
}

const rsvp = (
  server: Server,
  body: Record<string, string>,
  userId?: string,
  idempotencyKey?: string,
) =>
  server.inject({
    method: 'POST',
    url: '/rsvp',
    headers: {
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      ...(userId ? { 'x-user-id': userId } : {}),
    },
    payload: body,
  });

describe('POST /rsvp', () => {
  it('fulfills a free RSVP with zero totals and one valid entitlement', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    const response = await rsvp(server, { eventId, tierId });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.order).toMatchObject({
      eventId,
      userId: 'user_1',
      status: 'paid',
      currency: 'INR',
      subtotalPaise: 0,
      grandTotalPaise: 0,
      appliedPromoCode: null,
      paymentIntentId: null,
    });
    expect(body.order.lines).toHaveLength(1);
    expect(body.order.lines[0]).toMatchObject({ tierId, quantity: 1, unitPricePaise: 0 });
    expect(body.entitlements).toHaveLength(1);
    expect(body.entitlements[0]).toMatchObject({
      eventId,
      tierId,
      orderId: body.order.id,
      userId: 'user_1',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
    });
    await server.close();
  });

  it('rejects a second RSVP from the same account with 409', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    const first = await rsvp(server, { eventId, tierId });
    expect(first.statusCode).toBe(201);

    const second = await rsvp(server, { eventId, tierId });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'conflict', status: 409 });
    await server.close();
  });

  it('lets a different account RSVP the same event (1 per account, not per event)', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    expect((await rsvp(server, { eventId, tierId }, 'user_1')).statusCode).toBe(201);
    const other = await rsvp(server, { eventId, tierId }, 'user_2');
    expect(other.statusCode).toBe(201);
    expect(other.json().order.userId).toBe('user_2');
    await server.close();
  });

  it('rejects a non-zero tier on a free event with 400', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server, { priceInPaise: 50_000 });

    const response = await rsvp(server, { eventId, tierId });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });

  it('rejects a free tier on a paid event with 400', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server, { isFree: false });

    const response = await rsvp(server, { eventId, tierId });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });

  it('rejects an RSVP for an unpublished event with 400', async () => {
    const server = await buildServer();
    // Seed without publishing: org → venue → event (draft) → tier.
    const created = await server.inject({
      method: 'POST',
      url: '/organizations',
      headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
      payload: { name: 'Draft House', slug: `draft-house-${keySeq}` },
    });
    const org: string = created.json().id;
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: write(org),
      payload: { name: 'Basement', slug: `basement-${keySeq}` },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: write(org),
      payload: {
        title: 'Unlisted Night',
        venueId: venue.json().id,
        startAt: '2026-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;
    const tier = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: { name: 'RSVP', priceInPaise: 0, quantity: 10 },
    });

    const response = await rsvp(server, { eventId, tierId: tier.json().id });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });

  it('404s unknown event and unknown tier (no existence oracle beyond 404)', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    const badEvent = await rsvp(server, { eventId: 'evt_does_not_exist', tierId });
    expect(badEvent.statusCode).toBe(404);

    const badTier = await rsvp(server, { eventId, tierId: 'tier_does_not_exist' });
    expect(badTier.statusCode).toBe(404);
    await server.close();
  });

  it('exhausts inventory: the last ticket goes to exactly one account', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server, { quantity: 1 });

    expect((await rsvp(server, { eventId, tierId }, 'user_1')).statusCode).toBe(201);
    const loser = await rsvp(server, { eventId, tierId }, 'user_2');
    expect(loser.statusCode).toBe(400);
    expect(loser.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });
});
