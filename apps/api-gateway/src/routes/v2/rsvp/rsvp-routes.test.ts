import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { seedApprovedPartnerOrganization } from '../../../test-utils/approved-partner-organization.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import scannerRoutes from '../door/scanner-routes.js';
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
      scannerRoutes,
    ],
  });

function seedVerifiedTestAccounts(): void {
  const users = createV2Services().repos().users;
  if (!('save' in users) || typeof users.save !== 'function') {
    throw new Error('RSVP route tests require the in-memory user-account repository');
  }
  for (const id of ['user_1', 'user_2']) {
    users.save({
      id,
      email: `${id}@example.test`,
      name: id,
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: 0,
      updatedAt: 0,
    });
  }
}

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
  ++keySeq;
  const created = await seedApprovedPartnerOrganization({
    name: 'Skyline',
    slug: `skyline-${keySeq}`,
  });
  expect(created.status).toBe('active');
  const org: string = created.id;

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
    payload: {
      title: 'Free Night',
      venueId,
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      summary: 'Test RSVP event',
      description: 'Connected route fixture for free entry.',
    },
  });
  expect(event.statusCode).toBe(201);
  const eventId: string = event.json().id;
  // New events default to `isFree: true`; the paid-event case flips it.
  if (options.isFree === false) {
    const paidTier = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: { name: 'Paid', accessType: 'ENTRY', priceInPaise: 1000, quantity: 10 },
    });
    expect(paidTier.statusCode).toBe(201);
  }

  const tier = await server.inject({
    method: 'POST',
    url: `/events/${eventId}/ticket-tiers`,
    headers: write(org),
    payload: {
      name: 'RSVP',
      accessType: options.priceInPaise ? 'ENTRY' : 'RSVP',
      ...(options.priceInPaise ? { priceInPaise: options.priceInPaise } : {}),
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
    expect(transition.statusCode, transition.body).toBe(200);
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
    seedVerifiedTestAccounts();
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
    expect(body).not.toHaveProperty('referralAttributionStatus');
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

  it('fulfills the RSVP without exposing whether its referral code is available', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: '/rsvp',
      headers: { 'idempotency-key': `rsvp-invalid-ref-${++keySeq}` },
      payload: { eventId, tierId, referralCode: 'REVOKED-CODE' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).not.toHaveProperty('referralAttributionStatus');
    await server.close();
  });

  it('replays a second RSVP from the same account without creating another ticket', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    const first = await rsvp(server, { eventId, tierId });
    expect(first.statusCode).toBe(201);

    const second = await rsvp(server, { eventId, tierId });
    expect(second.statusCode).toBe(201);
    expect(second.json().order.id).toBe(first.json().order.id);
    expect(second.json().entitlements.map((item: { id: string }) => item.id)).toEqual(
      first.json().entitlements.map((item: { id: string }) => item.id),
    );
    await server.close();
  });

  it('lets a different account RSVP the same event (1 per account, not per event)', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    expect((await rsvp(server, { eventId, tierId }, 'user_1')).statusCode).toBe(201);
    const other = await rsvp(server, { eventId, tierId }, 'user_2');
    expect(other.statusCode).toBe(201);
    expect(other.json().order.userId).toBe('user_2');
    await server.close();
  });

  it('denies RSVP for an unverified account and an account missing from the directory', async () => {
    seedVerifiedTestAccounts();
    const users = createV2Services().repos().users;
    if (!('save' in users) || typeof users.save !== 'function') {
      throw new Error('RSVP route tests require the in-memory user-account repository');
    }
    users.save({
      id: 'rsvp-unverified',
      email: 'unverified@example.test',
      name: 'Unverified',
      image: null,
      emailVerified: false,
      role: 'guest',
      createdAt: 0,
      updatedAt: 0,
    });
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    expect((await rsvp(server, { eventId, tierId }, 'rsvp-unverified')).statusCode).toBe(403);
    expect((await rsvp(server, { eventId, tierId }, 'rsvp-missing')).statusCode).toBe(403);
    await server.close();
  });

  it('rejects a non-zero tier on a free event with 400', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    const { eventId, tierId } = await seed(server, { priceInPaise: 50_000 });

    const response = await rsvp(server, { eventId, tierId });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });

  it('fulfills a free tier on an event with paid entry', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    const { eventId, tierId } = await seed(server, { isFree: false });

    const response = await rsvp(server, { eventId, tierId });
    expect(response.statusCode).toBe(201);
    expect(response.json().entitlements).toHaveLength(1);
    await server.close();
  });

  it('rejects an RSVP for an unpublished event with 400', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    // Seed without publishing: org → venue → event (draft) → tier.
    ++keySeq;
    const created = await seedApprovedPartnerOrganization({
      name: 'Draft House',
      slug: `draft-house-${keySeq}`,
    });
    const org: string = created.id;
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
        startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    });
    const eventId: string = event.json().id;
    const tier = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: { name: 'RSVP', accessType: 'RSVP', quantity: 10 },
    });

    const response = await rsvp(server, { eventId, tierId: tier.json().id });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });

  it('404s unknown event and unknown tier (no existence oracle beyond 404)', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    const { eventId, tierId } = await seed(server);

    const badEvent = await rsvp(server, { eventId: 'evt_does_not_exist', tierId });
    expect(badEvent.statusCode).toBe(404);

    const badTier = await rsvp(server, { eventId, tierId: 'tier_does_not_exist' });
    expect(badTier.statusCode).toBe(404);
    await server.close();
  });

  it('exhausts inventory: the last ticket goes to exactly one account', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    const { eventId, tierId } = await seed(server, { quantity: 1 });

    expect((await rsvp(server, { eventId, tierId }, 'user_1')).statusCode).toBe(201);
    const loser = await rsvp(server, { eventId, tierId }, 'user_2');
    expect(loser.statusCode).toBe(400);
    expect(loser.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });
});

describe('M3 RSVP cancellation HTTP acceptance', () => {
  it('cancels only the purchaser RSVP, replays safely, and immediately invalidates QR issuance', async () => {
    seedVerifiedTestAccounts();
    const server = await buildServer();
    try {
      const { eventId, tierId } = await seed(server, { quantity: 1 });
      const acquired = await rsvp(server, { eventId, tierId });
      expect(acquired.statusCode, acquired.body).toBe(201);
      const body = acquired.json<{
        order: { id: string };
        entitlements: { id: string; credentialVersion?: number }[];
      }>();
      const ticket = body.entitlements[0];
      if (!ticket) throw new Error('Expected RSVP entitlement');
      const qrBefore = await server.inject({ method: 'GET', url: `/tickets/${ticket.id}/qr` });
      expect(qrBefore.statusCode, qrBefore.body).toBe(200);
      const url = `/rsvp/${body.order.id}/cancel`;
      const foreign = await server.inject({
        method: 'POST',
        url,
        headers: { 'x-user-id': 'user_2' },
      });
      expect(foreign.statusCode).toBe(404);
      const cancelled = await server.inject({ method: 'POST', url });
      const replay = await server.inject({ method: 'POST', url });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json()).toMatchObject({ order: { id: body.order.id, status: 'cancelled' } });
      expect(replay.json()).toEqual(cancelled.json());
      const qrAfter = await server.inject({ method: 'GET', url: `/tickets/${ticket.id}/qr` });
      expect(qrAfter.statusCode).toBe(409);
      expect(qrAfter.body).not.toContain('qrPayload');
      const stored = await createV2Services().repos().entitlements.getById(ticket.id);
      expect(stored).toMatchObject({ status: 'void' });
      expect(stored?.pendingTransferId ?? null).toBeNull();
      expect(stored?.credentialVersion).toBeGreaterThan(ticket.credentialVersion ?? 1);
      const replacement = await rsvp(server, { eventId, tierId }, 'user_2');
      expect(replacement.statusCode, replacement.body).toBe(201);
      const invalidId = await server.inject({ method: 'POST', url: '/rsvp/not-an-order/cancel' });
      expect(invalidId.statusCode).toBe(422);
    } finally {
      await server.close();
    }
  });
});
