import { describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';

import { createV2Services } from '../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../test-utils/partner-test-server.js';

import phase5Routes from './phase5-routes.js';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * ─── GET /door/stats (Founder Task B2) ────────────────────────────────────
 * Same `fakeAuthPlugin` local stand-in as `door/door-sale-routes.test.ts` —
 * `buildPartnerTestServer` never registers the real auth plugin, so this
 * derives `request.actor` straight from `x-organization-id`.
 */
async function fakeAuthPlugin(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const organizationId = request.headers['x-organization-id'];
    if (typeof organizationId === 'string' && organizationId.length > 0) {
      request.actor = {
        userId: 'user_1',
        organizationId,
        role: 'owner',
        capabilities: [],
        platformRole: 'partner',
      };
    }
  });
}

const buildServer = () => buildPartnerTestServer({ routes: [fakeAuthPlugin, phase5Routes] });

const ACTOR: ActorContext = {
  userId: 'user_1',
  organizationId: 'org_1',
  role: 'owner',
  capabilities: [],
};
const HEADERS = { 'x-organization-id': 'org_1' };

describe('GET /door/stats', () => {
  it('aggregates scan-ledger, door-sale, and cover-wallet counts for one event', async () => {
    const server = await buildServer();
    const services = createV2Services();

    const event = await services.events.create(ACTOR, {
      venueId: 'ven_1',
      title: 'Door Stats Test Night',
      startAt: '2026-09-01T18:00:00Z',
    });

    const seedScan = (status: 'consumed' | 'denied', entitlementId: string) =>
      services.repos().scanLedger.create({
        eventId: event.id,
        organizationId: 'org_1',
        venueId: null,
        entitlementId,
        doorSaleId: null,
        entryType: null,
        tierName: 'General',
        tierId: 'tier_1',
        operatorUid: ACTOR.userId,
        operatorName: 'Staff One',
        operatorRole: 'staff',
        gate: null,
        deviceId: 'device_1',
        deviceName: 'Gate iPad 1',
        deviceBound: true,
        guestName: 'Guest',
        guestEmail: null,
        guestPhone: null,
        scannedAt: new Date().toISOString(),
        admittedCount: status === 'consumed' ? 1 : 0,
        scanCountUsed: status === 'consumed' ? 1 : 0,
        scanCountAllowed: 1,
        isOffline: false,
        offlineDeviceId: null,
        status,
        denyReason: status === 'denied' ? 'already_used' : null,
        denyMessage: status === 'denied' ? 'Ticket already scanned' : null,
      });
    await seedScan('consumed', 'ent_1');
    await seedScan('consumed', 'ent_2');
    await seedScan('denied', 'ent_3');

    const walkInTier = await services.catalog.createTier(ACTOR, {
      eventId: event.id,
      name: 'Walk-in',
      entryType: 'walkin',
      priceInPaise: 50_000,
      quantity: 100,
    });
    await services.door.createWalkIn(
      {
        eventId: event.id,
        guestName: 'Ada Lovelace',
        totalGuests: 1,
        paymentMode: 'cash',
        idempotencyKey: 'idem-stats-walkin-1',
      },
      ACTOR,
    );

    await services.repos().coverWallets.create({
      userId: 'user_wallet_1',
      eventId: event.id,
      organizationId: 'org_1',
      venueId: null,
      openingBalance: 300_000,
    });

    const response = await server.inject({
      method: 'GET',
      url: `/door/stats?eventId=${event.id}`,
      headers: HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      eventId: event.id,
      scans: {
        total: 3,
        consumed: 2,
        denied: 1,
        pending: 0,
        revoked: 0,
        overridden: 0,
        expired: 0,
        cancelled: 0,
      },
      doorSales: {
        count: 1,
        grossPaise: walkInTier.priceInPaise,
      },
      coverWallet: {
        activeWallets: 1,
        totalBalancePaise: 300_000,
        totalCreditsPaise: 300_000,
        totalDebitsPaise: 0,
      },
    });
    expect(typeof body.generatedAt).toBe('string');
    await server.close();
  });

  it("hides another tenant's event behind not-found", async () => {
    const server = await buildServer();
    const services = createV2Services();
    const event = await services.events.create(ACTOR, {
      venueId: 'ven_1',
      title: 'Other Org Event',
      startAt: '2026-09-01T18:00:00Z',
    });

    const response = await server.inject({
      method: 'GET',
      url: `/door/stats?eventId=${event.id}`,
      headers: { 'x-organization-id': 'org_2' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });
});

describe('GET /door/stats/ws', () => {
  it('returns a flat V2 error envelope, not a raw { error } body (honest 501)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/door/stats/ws',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ code: 'server', status: 501 });
    expect(response.json()).toHaveProperty('requestId');
    await server.close();
  });
});
