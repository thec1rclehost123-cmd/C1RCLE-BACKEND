import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import partnerEventCatalogRoutes from '../partner/event-catalog.js';
import partnerEventRoutes from '../partner/events.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerVenueRoutes from '../partner/venues.js';

import checkoutRoutes from './checkout-routes.js';

/**
 * ─── Guest checkout over HTTP (Phase 4 PR2) ─────────────────────────────────
 * `POST /checkout/quote` (pure calculation) and `POST /checkout/holds`
 * (reserves inventory). Asserts the transport contract plus the two
 * correctness properties the sprint's exit gate names explicitly: pricing
 * reconciles, and two guests cannot both hold the last ticket.
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
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;

const write = (org: string) => ({
  'x-organization-id': org,
  'idempotency-key': `catalog-key-${++keySeq}`,
});

/** Creates org → venue → event → one ticket tier; returns everything checkout needs. */
async function seed(
  server: Server,
  options: { priceInPaise?: number; quantity?: number } = {},
): Promise<{ org: string; eventId: string; tierId: string; priceInPaise: number }> {
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

  const priceInPaise = options.priceInPaise ?? 150_000;
  const quantity = options.quantity ?? 100;
  const tier = await server.inject({
    method: 'POST',
    url: `/events/${eventId}/ticket-tiers`,
    headers: write(org),
    payload: { name: 'General', priceInPaise, quantity },
  });
  const tierId: string = tier.json().id;

  return { org, eventId, tierId, priceInPaise };
}

describe('POST /checkout/quote', () => {
  it('returns a reconciling pricing breakdown for the requested lines', async () => {
    const server = await buildServer();
    const { eventId, tierId, priceInPaise } = await seed(server, { priceInPaise: 150_000 });

    const response = await server.inject({
      method: 'POST',
      url: '/checkout/quote',
      payload: { eventId, lines: [{ tierId, quantity: 2 }] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.subtotalPaise).toBe(priceInPaise * 2);
    expect(body.currency).toBe('INR');
    // Order of operations (pricing.ts): subtotal -> discount -> fees on the
    // discounted subtotal -> GST on fees only. The breakdown must reconcile.
    expect(Number(body.grandTotalPaise)).toBe(
      Number(body.discountedSubtotalPaise) +
        Number(body.platformFeePaise) +
        Number(body.paymentFeePaise) +
        Number(body.gstPaise),
    );
    expect(body.grandTotalPaise).toBeGreaterThan(body.subtotalPaise);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ tierId, quantity: 2, unitPricePaise: priceInPaise });
    await server.close();
  });

  it('unknown tier id -> 400 invalid_operation, not a 500', async () => {
    const server = await buildServer();
    const { eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: '/checkout/quote',
      payload: { eventId, lines: [{ tierId: 'tier_does_not_exist', quantity: 1 }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });

  it('unknown event id -> 400 (no tiers found for it), never a 500', async () => {
    // `quote()` prices lines against the event's catalog — it has no
    // dedicated event-existence check, so an unknown event surfaces as "tier
    // not found" (400) rather than a distinct 404. `createHold`, below, does
    // check event existence explicitly (it needs `organizationId` off the
    // event) and returns a proper 404 for the same bad id.
    const server = await buildServer();

    const response = await server.inject({
      method: 'POST',
      url: '/checkout/quote',
      payload: { eventId: 'event_does_not_exist', lines: [{ tierId: 'tier_1', quantity: 1 }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });

  it('createHold on an unknown event id -> 404 not_found', async () => {
    const server = await buildServer();

    const response = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      headers: { 'idempotency-key': 'hold-unknown-event' },
      payload: { eventId: 'event_does_not_exist', lines: [{ tierId: 'tier_1', quantity: 1 }] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });
});

describe('POST /checkout/holds', () => {
  it('requires Idempotency-Key -> 422 validation', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      payload: { eventId, lines: [{ tierId, quantity: 1 }] },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('idempotency-key');
    await server.close();
  });

  it('reserves inventory and returns an active hold with its pricing', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      headers: { 'idempotency-key': 'hold-key-1' },
      payload: { eventId, lines: [{ tierId, quantity: 1 }] },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ status: 'active', convertedOrderId: null });
    expect(body.holdId).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
    expect(body.pricing.lines).toHaveLength(1);
    await server.close();
  });

  it('replays the same hold for a repeated Idempotency-Key (no double reservation)', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);
    const payload = { eventId, lines: [{ tierId, quantity: 1 }] };

    const first = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      headers: { 'idempotency-key': 'hold-key-replay' },
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      headers: { 'idempotency-key': 'hold-key-replay' },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().holdId).toBe(first.json().holdId);
    await server.close();
  });

  it('cannot both hold the last ticket — second guest is turned away', async () => {
    const server = await buildServer();
    const { eventId, tierId } = await seed(server, { quantity: 1 });

    const first = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      headers: { 'idempotency-key': 'hold-key-race-1' },
      payload: { eventId, lines: [{ tierId, quantity: 1 }] },
    });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      headers: { 'idempotency-key': 'hold-key-race-2' },
      payload: { eventId, lines: [{ tierId, quantity: 1 }] },
    });

    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });
});
