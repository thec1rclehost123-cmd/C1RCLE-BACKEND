import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import eventCoverRedemptionRoutes from './event-cover-redemption-routes.js';

describe('event cover redemption challenge reads', () => {
  it('uses private no-store and returns a generic not-found for an unknown Guest challenge', async () => {
    const server = await buildPartnerTestServer({ routes: [eventCoverRedemptionRoutes] });
    const response = await server.inject({
      method: 'GET',
      url: '/wallet/event-cover-redemption-challenges/missing-cover-challenge',
      headers: { 'x-user-id': 'cover-route-guest' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toContain('private');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).not.toContain('guestUserId');
    expect(response.body).not.toContain('venueOrganizationId');
    await server.close();
  });

  it('keeps Guest confirmation private and hides challenges that are not owned by the Guest', async () => {
    const server = await buildPartnerTestServer({ routes: [eventCoverRedemptionRoutes] });
    const response = await server.inject({
      method: 'POST',
      url: '/wallet/event-cover-redemption-challenges/missing-cover-challenge/confirm',
      headers: { 'x-user-id': 'cover-route-guest' },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).not.toContain('guestUserId');
    expect(response.body).not.toContain('venueOrganizationId');
    await server.close();
  });

  it('requires door management permission before creating a redemption challenge', async () => {
    const server = await buildPartnerTestServer({
      routes: [eventCoverRedemptionRoutes],
      actorRole: 'member',
    });
    const response = await server.inject({
      method: 'POST',
      url: '/event-cover/redemption-challenges',
      headers: {
        'x-organization-id': 'cover-route-venue',
        'idempotency-key': 'cover-route-create-test-1',
      },
      payload: {
        entitlementId: 'cover-route-ticket',
        amountPaise: 100,
        grossSpendPaise: 100,
        categories: ['food'],
        containsAlcohol: false,
        receiptReference: 'receipt-test-1',
        terminalId: 'terminal-test-1',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden', status: 403 });
    await server.close();
  });
});
