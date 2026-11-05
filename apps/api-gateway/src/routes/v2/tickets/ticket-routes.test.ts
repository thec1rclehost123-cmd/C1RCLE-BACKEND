import {
  createSocialNotification,
  eventMaterialChangeSubjectId,
  MemoryPaymentProvider,
} from '@c1rcle/core/domain';
import { describe, expect, it, vi } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { seedApprovedPartnerOrganization } from '../../../test-utils/approved-partner-organization.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import { publishEventForTest } from '../../../test-utils/publish-event.js';
import { seedVerifiedCheckoutUsers } from '../../../test-utils/verified-test-users.js';
import checkoutRoutes from '../checkout/checkout-routes.js';
import paymentRoutes from '../checkout/payment-routes.js';
import partnerEventCatalogRoutes from '../partner/event-catalog.js';
import partnerEventRoutes from '../partner/events.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerVenueRoutes from '../partner/venues.js';
import walletRoutes from '../wallet/wallet-routes.js';

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

/** Seeds org -> venue -> event -> tier -> hold -> paid order, returns its ticket id. */
async function seedTicket(server: Server): Promise<string> {
  seedVerifiedCheckoutUsers(['user_1']);
  ++keySeq;
  const created = await seedApprovedPartnerOrganization({
    name: 'Skyline',
    slug: `skyline-${keySeq}`,
  });
  const org: string = created.id;
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
    payload: { title: 'Sky Night', venueId, startAt: '2026-12-01T18:00:00Z' },
  });
  const eventId: string = event.json().id;
  await publishEventForTest(eventId);
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
  provider.simulateCapture(paymentId, grandTotalPaise, paymentIntentId);
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
    expect(response.headers['cache-control']).toContain('no-store');
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

describe('ticket transfer HTTP surface', () => {
  it('keeps transfer mutations disabled by default', async () => {
    const server = await buildServer();
    const ticketId = await seedTicket(server);

    const response = await server.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/transfers`,
      payload: { recipientEmail: 'recipient@example.test' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'server' });
    await server.close();
  });

  it('accepts only a recipient email and rejects opaque account-id input', async () => {
    const server = await buildServer();
    const ticketId = await seedTicket(server);

    const opaqueId = await server.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/transfers`,
      payload: { recipientUserId: 'USR-recipient' },
    });
    const malformedEmail = await server.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/transfers`,
      payload: { recipientEmail: 'not-an-email' },
    });

    expect(opaqueId.statusCode).toBe(422);
    expect(malformedEmail.statusCode).toBe(422);
    await server.close();
  });
});

describe('material event-change response HTTP surface', () => {
  it('records a ticket-holder response through the authenticated route', async () => {
    const server = await buildServer();
    const ticketId = await seedTicket(server);
    const services = createV2Services();
    const entitlement = await services.tickets.getById(ticketId, {
      userId: 'user_1',
      organizationId: '',
      role: 'owner',
      capabilities: [],
    });
    const eventVersion = 2;
    const subjectId = eventMaterialChangeSubjectId(
      entitlement.eventId,
      eventVersion,
      entitlement.orderId,
      entitlement.id,
    );
    await services.socialNotifications.create(
      createSocialNotification({
        userId: 'user_1',
        type: 'event.material_change',
        title: 'Event details changed',
        body: 'Review the current event details.',
        link: '/tickets',
        subjectId,
        eventChange: {
          eventVersion,
          entitlementId: entitlement.id,
          canAccept: true,
          canRequestRefund: true,
        },
        now: new Date('2026-10-28T12:00:00.000Z'),
      }),
    );

    const response = await server.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/event-changes/${eventVersion}/respond`,
      payload: { response: 'accepted' },
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/event-changes/${eventVersion}/respond`,
      payload: { response: 'accepted' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entitlementId: ticketId,
      eventVersion,
      response: 'accepted',
      refundCreated: false,
      replayed: false,
    });
    expect(replay.json()).toMatchObject({ replayed: true });
    expect(response.headers['cache-control']).toContain('no-store');
    await server.close();
  });
});

const ownerActor = {
  userId: 'user_1',
  organizationId: '',
  role: 'owner' as const,
  capabilities: [],
};

async function withOnlineTransfers(run: () => Promise<void>) {
  const features = createV2Services().config().features;
  const previous = features.m5OfflineTicketManifests;
  Object.assign(features, { m5OfflineTicketManifests: false });
  try {
    await run();
  } finally {
    Object.assign(features, { m5OfflineTicketManifests: previous });
  }
}

function expectPrivateResponse(response: { body: string; headers: Record<string, unknown> }) {
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.body).not.toMatch(/recipientEmail|recipientUserId|senderUserId|@example\.test/);
}

describe('M3 authoritative HTTP ticket management', () => {
  it('projects unassigned purchaser custody in management and paginated booking roster only', async () => {
    const server = await buildServer();
    try {
      const ticketId = await seedTicket(server);
      const services = createV2Services();
      const ticket = await services.tickets.getById(ticketId, ownerActor);
      await services.repos().entitlements.save({
        ...ticket,
        currentHolderUserId: null,
        holderName: '',
        version: ticket.version + 1,
      });
      const management = await server.inject({
        method: 'GET',
        url: `/tickets/${ticketId}/management`,
      });
      expect(management.statusCode, management.body).toBe(200);
      expect(management.json()).toMatchObject({
        id: ticketId,
        ownership: 'unassigned',
        holderName: null,
        eventStatus: 'published',
        canPresent: false,
      });
      expectPrivateResponse(management);
      const roster = await server.inject({ method: 'GET', url: '/wallet/booking-tickets?limit=1' });
      expect(roster.statusCode, roster.body).toBe(200);
      expect(roster.json().items).toHaveLength(1);
      const allIds: string[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await server.inject({
          method: 'GET',
          url: `/wallet/booking-tickets?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        });
        expect(page.statusCode, page.body).toBe(200);
        const body: { items: { id: string }[]; nextCursor: string | null } = page.json();
        allIds.push(...body.items.map((item) => item.id));
        if (body.nextCursor) {
          expect(seenCursors.has(body.nextCursor)).toBe(false);
          seenCursors.add(body.nextCursor);
        }
        cursor = body.nextCursor;
      } while (cursor);
      expect(allIds.filter((id) => id === ticketId)).toHaveLength(1);
      expect(new Set(allIds).size).toBe(allIds.length);
      const holderWallet = await server.inject({ method: 'GET', url: '/wallet/tickets' });
      expect(holderWallet.json().items.some((item: { id: string }) => item.id === ticketId)).toBe(
        false,
      );
      const stranger = await server.inject({
        method: 'GET',
        url: `/tickets/${ticketId}/management`,
        headers: { 'x-user-id': 'outsider-management' },
      });
      expect(stranger.statusCode).toBe(404);
      const otherRoster = await server.inject({
        method: 'GET',
        url: '/wallet/booking-tickets',
        headers: { 'x-user-id': 'outsider-management' },
      });
      expect(otherRoster.json()).toMatchObject({ items: [], nextCursor: null, total: 0 });
    } finally {
      await server.close();
    }
  });

  it('requests review only for a verified purchaser and replays without issuing a provider refund', async () => {
    const server = await buildServer();
    const refund = vi.spyOn(memoryProvider(), 'refundPayment');
    try {
      const ticketId = await seedTicket(server);
      const services = createV2Services();
      const ticket = await services.tickets.getById(ticketId, ownerActor);
      seedVerifiedCheckoutUsers(['refund-outsider']);
      const outsider = await server.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/refund-review`,
        headers: { 'x-user-id': 'refund-outsider' },
        payload: { reason: 'I do not own this booking.' },
      });
      expect(outsider.statusCode).toBe(404);
      const unverified = await server.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/refund-review`,
        headers: { 'x-user-id': 'unverified-refund-user' },
        payload: { reason: 'Please review this booking.' },
      });
      expect(unverified.statusCode).toBe(401);
      const response = await server.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/refund-review`,
        payload: { reason: 'Please review my unused ticket.' },
      });
      const replay = await server.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/refund-review`,
        payload: { reason: 'Repeated after a connection interruption.' },
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(response.json());
      expect(response.json()).toMatchObject({ status: 'open' });
      expectPrivateResponse(response);
      const review = await services
        .repos()
        .supportTickets.getById(response.json<{ id: string }>().id);
      expect(review?.description).toBe('Please review my unused ticket.');
      expect(review?.refundReview?.entitlementIds).toEqual([ticketId]);
      expect((await services.repos().orders.getById(ticket.orderId))?.status).toBe('paid');
      expect((await services.repos().entitlements.getById(ticketId))?.refundLock).toBeNull();
      expect(refund).not.toHaveBeenCalled();
    } finally {
      refund.mockRestore();
      await server.close();
    }
  });
});

describe('M3 exact-email transfer HTTP acceptance', () => {
  it('creates a private invitation, previews only for the verified exact email, lists and resends it', async () => {
    await withOnlineTransfers(async () => {
      const server = await buildServer();
      try {
        const ticketId = await seedTicket(server);
        seedVerifiedCheckoutUsers(['recipient-http', 'wrong-recipient-http']);
        const created = await server.inject({
          method: 'POST',
          url: `/tickets/${ticketId}/transfers`,
          payload: { recipientEmail: 'RECIPIENT-HTTP@example.test' },
        });
        expect(created.statusCode, created.body).toBe(201);
        const transferId = created.json<{ id: string }>().id;
        const preview = await server.inject({
          method: 'GET',
          url: `/ticket-transfers/${transferId}`,
          headers: { 'x-user-id': 'recipient-http' },
        });
        expect(preview.statusCode, preview.body).toBe(200);
        expect(preview.json()).toMatchObject({
          id: transferId,
          status: 'pending',
          canAccept: true,
        });
        expectPrivateResponse(preview);
        const users = createV2Services().repos().users;
        const recipient = await users.getById('recipient-http');
        if (!recipient || !('save' in users) || typeof users.save !== 'function')
          throw new Error('Expected mutable memory recipient fixture');
        users.save({ ...recipient, email: 'changed-address@example.test' });
        const changedEmail = await server.inject({
          method: 'GET',
          url: `/ticket-transfers/${transferId}`,
          headers: { 'x-user-id': 'recipient-http' },
        });
        expect(changedEmail.statusCode).toBe(404);
        users.save({ ...recipient, emailVerified: false });
        const unverifiedExactEmail = await server.inject({
          method: 'GET',
          url: `/ticket-transfers/${transferId}`,
          headers: { 'x-user-id': 'recipient-http' },
        });
        expect(unverifiedExactEmail.statusCode).toBe(404);
        users.save(recipient);
        const wrong = await server.inject({
          method: 'GET',
          url: `/ticket-transfers/${transferId}`,
          headers: { 'x-user-id': 'wrong-recipient-http' },
        });
        expect(wrong.statusCode).toBe(404);
        const unverified = await server.inject({
          method: 'GET',
          url: `/ticket-transfers/${transferId}`,
          headers: { 'x-user-id': 'unverified-http' },
        });
        expect(unverified.statusCode).toBe(404);
        const listed = await server.inject({
          method: 'GET',
          url: `/tickets/${ticketId}/transfers`,
        });
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json()).toHaveLength(1);
        const strangerList = await server.inject({
          method: 'GET',
          url: `/tickets/${ticketId}/transfers`,
          headers: { 'x-user-id': 'wrong-recipient-http' },
        });
        expect(strangerList.statusCode).toBe(404);
        const missingKey = await server.inject({
          method: 'POST',
          url: `/ticket-transfers/${transferId}/resend`,
        });
        expect(missingKey.statusCode).toBe(409);
        const resend = await server.inject({
          method: 'POST',
          url: `/ticket-transfers/${transferId}/resend`,
          headers: { 'idempotency-key': 'http-resend-intent-1' },
        });
        const replay = await server.inject({
          method: 'POST',
          url: `/ticket-transfers/${transferId}/resend`,
          headers: { 'idempotency-key': 'http-resend-intent-1' },
        });
        expect(resend.statusCode, resend.body).toBe(202);
        expect(replay.json()).toEqual({ requested: true });
        expectPrivateResponse(resend);
        const strangerResend = await server.inject({
          method: 'POST',
          url: `/ticket-transfers/${transferId}/resend`,
          headers: { 'x-user-id': 'recipient-http', 'idempotency-key': 'http-resend-intent-2' },
        });
        expect(strangerResend.statusCode).toBe(404);
        expectPrivateResponse(created);
        expectPrivateResponse(listed);
      } finally {
        await server.close();
      }
    });
  });

  it.each(['decline', 'cancel'] as const)(
    'allows the proper actor to %s and safely replay the terminal invitation',
    async (action) => {
      await withOnlineTransfers(async () => {
        const server = await buildServer();
        try {
          const ticketId = await seedTicket(server);
          seedVerifiedCheckoutUsers(['terminal-recipient-http', 'terminal-outsider-http']);
          const created = await server.inject({
            method: 'POST',
            url: `/tickets/${ticketId}/transfers`,
            payload: { recipientEmail: 'terminal-recipient-http@example.test' },
          });
          expect(created.statusCode, created.body).toBe(201);
          const transferId = created.json<{ id: string }>().id;
          const forbidden = await server.inject({
            method: 'POST',
            url: `/ticket-transfers/${transferId}/${action}`,
            headers: { 'x-user-id': 'terminal-outsider-http' },
          });
          expect(forbidden.statusCode).toBe(404);
          const headers = action === 'decline' ? { 'x-user-id': 'terminal-recipient-http' } : {};
          const resolved = await server.inject({
            method: 'POST',
            url: `/ticket-transfers/${transferId}/${action}`,
            headers,
          });
          const replay = await server.inject({
            method: 'POST',
            url: `/ticket-transfers/${transferId}/${action}`,
            headers,
          });
          const status = action === 'decline' ? 'declined' : 'cancelled';
          expect(resolved.statusCode, resolved.body).toBe(200);
          expect(resolved.json()).toMatchObject({ transfer: { id: transferId, status } });
          expect(replay.json()).toEqual(resolved.json());
          expect(
            (await createV2Services().repos().entitlements.getById(ticketId))?.pendingTransferId,
          ).toBeNull();
          const resend = await server.inject({
            method: 'POST',
            url: `/ticket-transfers/${transferId}/resend`,
            headers: { 'idempotency-key': 'terminal-no-resend' },
          });
          expect(resend.statusCode).toBe(409);
          expectPrivateResponse(resolved);
        } finally {
          await server.close();
        }
      });
    },
  );
});
