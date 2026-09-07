import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import partnerOrganizationRoutes from '../partner/organizations.js';

import financeRoutes from './finance-routes.js';

/**
 * ─── Finance routes over HTTP (Phase 6) ─────────────────────────────────────
 * Ledger writes have no HTTP entrypoint yet (checkout webhook integration is
 * a follow-up) — seeded directly via `services.finance.recordTicketSale` to
 * exercise balance/ledger reads, mirroring how `wallet-routes.test.ts` seeds
 * through the service layer where no route exists for it.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({ routes: [partnerOrganizationRoutes, financeRoutes] });

type Server = Awaited<ReturnType<typeof buildServer>>;

const write = (org: string) => ({
  'x-organization-id': org,
  'idempotency-key': `finance-key-${++keySeq}`,
});

async function seedOrganization(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Finance Test Org', slug: `finance-org-${++keySeq}` },
  });
  return created.json().id as string;
}

describe('GET /organizations/:organizationId/finance/balance', () => {
  it('returns real zeroes for an organization with no ledger history', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/finance/balance`,
      headers: { 'x-organization-id': org },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ availablePaise: 0, pendingPaise: 0, lifetimePaise: 0 });
  });

  it('reflects a recorded ticket sale split correctly', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const actor = {
      userId: 'user_1',
      organizationId: org,
      role: 'owner' as const,
      capabilities: [],
      platformRole: 'partner' as const,
    };

    await createV2Services().finance.recordTicketSale(
      {
        organizationId: org,
        orderId: 'order_1',
        eventId: 'evt_1',
        grossAmount: 100_000,
        hostOrganizationId: org,
        venueOrganizationId: org,
        promoterOrganizationId: null,
        platformFeeRate: 0.15,
        venueShareRate: 0.1,
        promoterCommissionRate: null,
      },
      actor,
    );

    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/finance/balance`,
      headers: { 'x-organization-id': org },
    });
    expect(res.statusCode).toBe(200);
    // host_organization === venue_organization === org here, so this org
    // receives both venue_share (10_000) and host_payout (75_000) = 85_000,
    // all still 'settled' immediately (recordTicketSale marks host/venue
    // legs 'pending', so pending, not available, until settlement).
    const body = res.json();
    expect(body.pendingPaise).toBe(85_000);
    expect(body.availablePaise).toBe(0);
    expect(body.lifetimePaise).toBe(85_000);
  });

  it('rejects a cross-tenant balance read as forbidden', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const other = await seedOrganization(server);
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/finance/balance`,
      headers: { 'x-organization-id': other },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('bank accounts + payouts', () => {
  it('adds a bank account, sees it masked, and sets it default on the first add', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/bank-accounts`,
      headers: write(org),
      payload: {
        bankName: 'HDFC Bank',
        accountHolder: 'Test Org',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.maskedAccountNumber).toBe('••7890');
    expect(body.isDefault).toBe(true);
    expect(body).not.toHaveProperty('accountNumber');
    expect(body).not.toHaveProperty('encryptedAccountNumber');
  });

  it('rejects a payout request below the ₹100 minimum', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    await server.inject({
      method: 'POST',
      url: `/organizations/${org}/bank-accounts`,
      headers: write(org),
      payload: {
        bankName: 'HDFC Bank',
        accountHolder: 'Test Org',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/payouts`,
      headers: write(org),
      payload: { amountPaise: 5000, idempotencyKey: `payout-${++keySeq}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a payout request exceeding available balance', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    await server.inject({
      method: 'POST',
      url: `/organizations/${org}/bank-accounts`,
      headers: write(org),
      payload: {
        bankName: 'HDFC Bank',
        accountHolder: 'Test Org',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/payouts`,
      headers: write(org),
      payload: { amountPaise: 50_000, idempotencyKey: `payout-${++keySeq}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
