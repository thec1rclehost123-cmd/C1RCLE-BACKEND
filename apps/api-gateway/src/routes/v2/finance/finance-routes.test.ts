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

/**
 * Seeded ledger entries so the read routes (ledger list, payout list/get,
 * bank-account list) return deterministic content rather than empty lists.
 */
/**
 * Seeds a deterministic 4-leg ticket sale for `org` and returns the orderId.
 * `orderId` is unique per call because the memory ledger dedups ledger entries
 * by `idempotencyKey` AND `findByOrder` filters by orderId across ALL orgs —
 * reusing an orderId across tests would silently replay the earlier test's
 * entries instead of writing new ones.
 */
async function seedLedger(server: Server, org: string): Promise<string> {
  const orderId = `o${++keySeq}`;
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
      // Short orderId keeps generated entry IDs (`led-${orderId}-${type}-${org}`)
      // within the contract's 64-char opaqueId limit when org is a 36-char UUID.
      orderId,
      eventId: `e${keySeq}`,
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
  return orderId;
}

describe('GET /organizations/:organizationId/finance/ledger', () => {
  it('returns the recorded ledger entries as DTOs', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const orderId = await seedLedger(server, org);
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/finance/ledger`,
      headers: { 'x-organization-id': org },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // host === venue === org here, so the order splits into 4 entries for this
    // org: ticket_revenue, platform_fee, venue_share, host_payout.
    expect(body.pageInfo.total).toBe(4);
    expect(body.items.length).toBe(4);
    expect(body.items[0]).toMatchObject({
      orderId,
      entryType: 'ticket_revenue',
      amountPaise: 100_000,
      status: 'settled',
    });
    expect(body.items[0]).not.toHaveProperty('idempotencyKey');
    expect(body.items[0]).not.toHaveProperty('organizationId');
  });

  it('rejects a cross-tenant ledger read', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const other = await seedOrganization(server);
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/finance/ledger`,
      headers: { 'x-organization-id': other },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('payout list by id', () => {
  it('returns 404 for a missing payout', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/payouts/payout_nope`,
      headers: { 'x-organization-id': org },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /organizations/:organizationId/payouts', () => {
  async function seedSettledFundsAndBank(server: Server, org: string) {
    await seedLedger(server, org);
    const repro = createV2Services().repos();
    // Give the org a settled host_payout so a payout can actually be requested.
    // Unique id/idempotencyKey per org — the memory ledger dedups on BOTH.
    const fundedKey = `order_funded:host_payout:${org}`;
    await repro.ledger.createBatch([
      {
        id: `settled-${org}`,
        organizationId: org,
        orderId: 'order_funded',
        eventId: 'evt_funded',
        entryType: 'host_payout',
        amount: 100_000,
        status: 'settled',
        idempotencyKey: fundedKey,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const added = await server.inject({
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
    return added.json().id as string;
  }

  it('lists the org payouts', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    await seedSettledFundsAndBank(server, org);
    const req = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/payouts`,
      headers: write(org),
      payload: { amountPaise: 30_000, idempotencyKey: `listpayout-${++keySeq}` },
    });
    expect(req.statusCode).toBe(201);
    const payoutId = req.json().id as string;

    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/payouts`,
      headers: { 'x-organization-id': org },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(payoutId);
    expect(body.items[0].amountPaise).toBe(30_000);
    expect(body.items[0].status).toBe('requested');
  });

  it('returns a single payout by id', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    await seedSettledFundsAndBank(server, org);
    const req = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/payouts`,
      headers: write(org),
      payload: { amountPaise: 30_000, idempotencyKey: `getpayout-${++keySeq}` },
    });
    const payoutId = req.json().id as string;
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/payouts/${payoutId}`,
      headers: { 'x-organization-id': org },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(payoutId);
    expect(res.json().bankAccountId).toBeTruthy();
  });
});

describe('bank account read + lifecycle', () => {
  it('lists bank accounts', async () => {
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
      method: 'GET',
      url: `/organizations/${org}/bank-accounts`,
      headers: { 'x-organization-id': org },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].maskedAccountNumber).toBe('••7890');
  });

  it('sets an account as default via the endpoint', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const first = await server.inject({
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
    const second = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/bank-accounts`,
      headers: write(org),
      payload: {
        bankName: 'ICICI Bank',
        accountHolder: 'Test Org',
        accountNumber: '00009999888877',
        ifscCode: 'ICIC0001234',
      },
    });
    const secondId = second.json().id as string;
    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/bank-accounts/${secondId}/default`,
      headers: { 'x-organization-id': org },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(secondId);
    expect(res.json().isDefault).toBe(true);
    void first;
  });

  it('deletes a non-default bank account', async () => {
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
    const second = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/bank-accounts`,
      headers: write(org),
      payload: {
        bankName: 'ICICI Bank',
        accountHolder: 'Test Org',
        accountNumber: '00009999888877',
        ifscCode: 'ICIC0001234',
      },
    });
    const secondId = second.json().id as string;
    const del = await server.inject({
      method: 'DELETE',
      url: `/organizations/${org}/bank-accounts/${secondId}`,
      headers: { 'x-organization-id': org },
    });
    expect(del.statusCode).toBe(204);
  });

  it('returns 400 when deleting the default bank account', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const added = await server.inject({
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
    const bankId = added.json().id as string;
    const del = await server.inject({
      method: 'DELETE',
      url: `/organizations/${org}/bank-accounts/${bankId}`,
      headers: { 'x-organization-id': org },
    });
    expect(del.statusCode).toBe(400);
  });
});
