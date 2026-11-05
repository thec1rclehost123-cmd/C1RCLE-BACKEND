import { FinancialPostingService } from '@c1rcle/core/application';
import {
  applyProviderPaymentEvent,
  calculatePricing,
  createEvent,
  createOrder,
  createTicketTier,
  M4_ACCOUNTING_POLICY,
  MemoryPaymentProvider,
} from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import { publishEventForTest } from '../../../test-utils/publish-event.js';
import { seedVerifiedCheckoutUsers } from '../../../test-utils/verified-test-users.js';
import checkoutRoutes from '../checkout/checkout-routes.js';
import paymentRoutes from '../checkout/payment-routes.js';
import partnerEventCatalogRoutes from '../partner/event-catalog.js';
import partnerEventRoutes from '../partner/events.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerVenueRoutes from '../partner/venues.js';

import financeRoutes from './finance-routes.js';

import type * as ConfigModule from '../../../config/index.js';

// Explicitly opt in only for in-memory payout-route behavior tests. The real
// configuration default and the balance route remain safely disabled.
const payoutFlag = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../../config/index.js', async (importOriginal) => {
  const actual: typeof ConfigModule = await importOriginal();
  return {
    ...actual,
    getGatewayConfig: (...args: Parameters<typeof actual.getGatewayConfig>) => ({
      ...actual.getGatewayConfig(...args),
      PAYOUTS_ENABLED: payoutFlag.enabled,
    }),
  };
});

/**
 * ─── Finance routes over HTTP (Phase 6) ─────────────────────────────────────
 * Ledger writes have no HTTP entrypoint yet (checkout webhook integration is
 * a follow-up) — seeded directly via `services.finance.recordTicketSale` to
 * exercise balance/ledger reads, mirroring how `wallet-routes.test.ts` seeds
 * through the service layer where no route exists for it.
 *
 * The checkout/payment/venue/event routes are mounted too, because
 * `GET /finance/orders` is only meaningfully testable against a real paid order
 * — seeding one through a repository backdoor would skip the pricing
 * calculation that produces `grandTotalPaise` in the first place.
 */

let keySeq = 0;
const buildServer = ({ payoutsEnabled = false } = {}) => {
  payoutFlag.enabled = payoutsEnabled;
  return buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerEventCatalogRoutes,
      checkoutRoutes,
      paymentRoutes,
      financeRoutes,
    ],
  });
};

type Server = Awaited<ReturnType<typeof buildServer>>;

beforeEach(async () => {
  const repo = createV2Services().repos().journalTransition;
  const state = await repo.get();
  await repo.save({
    ...state,
    phase: 'legacy_reads',
    readModel: 'legacy_ledger_v1',
    version: state.version + 1,
  });
});

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
    expect(res.json()).toEqual({
      availablePaise: 0,
      pendingPaise: 0,
      reservedPaise: 0,
      heldPaise: 0,
      paidPaise: 0,
      lifetimePaise: 0,
      holds: {
        reservePaise: 0,
        cancellationPaise: 0,
        chargebackPaise: 0,
        reconciliationPaise: 0,
      },
      readModel: 'legacy_ledger_v1',
      payoutsEnabled: false,
      settlementUnavailableReason:
        'Settlement eligibility requires the controlled journal transition.',
    });
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
    const server = await buildServer({ payoutsEnabled: true });
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
    const server = await buildServer({ payoutsEnabled: true });
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
    // M4 eligibility requires authoritative journal proceeds and the event-end
    // clock. A settled compatibility-ledger row alone is never withdrawable.
    // This is an in-memory controlled fixture, not a deployment cutover.
    const state = await repro.journalTransition.get();
    await repro.journalTransition.save({
      ...state,
      phase: 'journal_reads',
      readModel: 'financial_journal_v2',
      version: state.version + 1,
    });
    const now = new Date();
    const event = {
      ...createEvent({
        id: `funded-event-${++keySeq}`,
        organizationId: org,
        venueId: 'venue-funded',
        title: 'Funded synthetic event',
        startAt: new Date(now.getTime() - 80 * 3600000).toISOString(),
        endAt: new Date(now.getTime() - 76 * 3600000).toISOString(),
        now,
      }),
      status: 'ended' as const,
    };
    await repro.events.save(event);
    const tier = createTicketTier({
      id: `funded-tier-${keySeq}`,
      eventId: event.id,
      organizationId: org,
      name: 'Entry',
      quantity: 10,
      priceInPaise: 100_000,
      now,
    });
    const order = {
      ...createOrder({
        id: `funded-order-${keySeq}`,
        eventId: event.id,
        organizationId: org,
        userId: 'buyer-funded',
        contact: { name: 'Synthetic buyer', email: '', phone: '' },
        pricing: calculatePricing({ lines: [{ tier, quantity: 1 }] }),
        now,
      }),
      // Legacy synthetic purchase has no M4 completion marker; this fixture
      // tests payout reservation, not paid fulfillment.
      status: 'paid' as const,
      paymentId: `pay-funded-${keySeq}`,
    };
    await repro.orders.save(order);
    await repro.providerPayments.save(
      applyProviderPaymentEvent(
        null,
        {
          type: 'captured',
          paymentId: order.paymentId,
          providerOrderId: `provider-funded-${keySeq}`,
          orderId: order.id,
          correlated: true,
          amountPaise: order.grandTotalPaise,
          currency: 'INR',
          feePaise: 0,
          taxOnFeePaise: 0,
          occurredAt: now.toISOString(),
        },
        now,
      ),
    );
    await new FinancialPostingService(repro.financialJournals).postTicketSale({
      organizationId: org,
      orderId: order.id,
      eventId: event.id,
      paymentId: order.paymentId,
      sourceType: 'online_payment_capture',
      providerConfirmed: true,
      currency: 'INR',
      ticketFaceValuePaise: order.subtotalPaise,
      discountPaise: 0,
      discountFundingOwner: null,
      netTicketRevenuePaise: order.discountedSubtotalPaise,
      gstPaise: order.gstPaise,
      platformFeePaise: order.platformFeePaise,
      paymentFeePaise: order.paymentFeePaise,
      allocation: {
        platformPaise: 0,
        hostOrganizationId: org,
        hostPaise: 100_000,
        venueOrganizationId: null,
        venuePaise: 0,
        promoterOrganizationId: null,
        promoterPaise: 0,
      },
      policy: M4_ACCOUNTING_POLICY,
      postedAt: now,
    });
    const balance = await createV2Services().finance.getBalances(org, {
      userId: 'user_1',
      organizationId: org,
      role: 'owner',
      capabilities: [],
    });
    expect(balance.availablePaise).toBe(100_000);
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
    const server = await buildServer({ payoutsEnabled: true });
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

  it('replays one payout request without creating a second reservation', async () => {
    const server = await buildServer({ payoutsEnabled: true });
    const org = await seedOrganization(server);
    await seedSettledFundsAndBank(server, org);
    const idempotencyKey = `replay-payout-${++keySeq}`;
    const payload = { amountPaise: 30_000, idempotencyKey };

    const first = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/payouts`,
      headers: write(org),
      payload,
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/payouts`,
      headers: write(org),
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    const listed = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/payouts`,
      headers: { 'x-organization-id': org },
    });
    expect(listed.json().items).toHaveLength(1);
    const journals = await createV2Services()
      .repos()
      .financialJournals.findBySource('payout_reservation', first.json().id as string);
    expect(journals).toHaveLength(1);
  });

  it('returns a single payout by id', async () => {
    const server = await buildServer({ payoutsEnabled: true });
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

describe('disputes', () => {
  it('raises, reviews, and resolves a dispute', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const raised = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes`,
      headers: write(org),
      payload: { orderId: 'order_1', reason: 'Payout amount mismatch', amountPaise: 5_000 },
    });
    expect(raised.statusCode).toBe(201);
    const dispute = raised.json();
    expect(dispute.status).toBe('open');
    expect(dispute.resolutionNote).toBeNull();

    const reviewed = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes/${dispute.id}/review`,
      headers: { 'x-organization-id': org },
      payload: {},
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().status).toBe('under_review');

    const resolved = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes/${dispute.id}/resolve`,
      headers: { 'x-organization-id': org },
      payload: { resolutionNote: 'Refund issued to the venue' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('resolved');
    expect(resolved.json().resolutionNote).toBe('Refund issued to the venue');
  });

  it('gets a dispute by id and lists disputes for the org', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const raised = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes`,
      headers: write(org),
      payload: { orderId: 'order_2', reason: 'Wrong split', amountPaise: 1_000 },
    });
    const disputeId = raised.json().id as string;

    const got = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/disputes/${disputeId}`,
      headers: { 'x-organization-id': org },
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().id).toBe(disputeId);

    const list = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/disputes`,
      headers: { 'x-organization-id': org },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });

  it('rejects a non-positive dispute amount', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes`,
      headers: write(org),
      payload: { orderId: 'order_3', reason: 'bad amount', amountPaise: 0 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a cross-tenant dispute read as not-found (IDOR-safe)', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const other = await seedOrganization(server);
    const raised = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes`,
      headers: write(org),
      payload: { orderId: 'order_4', reason: 'cross tenant', amountPaise: 1_000 },
    });
    const disputeId = raised.json().id as string;
    // Header matches the :organizationId path segment (`other`, satisfying the
    // wire-contract equality gate) but the dispute itself belongs to `org` —
    // exercises the service-level requireOrgAccess check, same pattern as
    // getPayout's cross-tenant 404.
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${other}/disputes/${disputeId}`,
      headers: { 'x-organization-id': other },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cannot resolve an already-resolved dispute', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const raised = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes`,
      headers: write(org),
      payload: { orderId: 'order_5', reason: 'double resolve', amountPaise: 1_000 },
    });
    const disputeId = raised.json().id as string;
    await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes/${disputeId}/resolve`,
      headers: { 'x-organization-id': org },
      payload: { resolutionNote: 'first' },
    });
    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/disputes/${disputeId}/resolve`,
      headers: { 'x-organization-id': org },
      payload: { resolutionNote: 'second' },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * ─── GET /organizations/:organizationId/finance/orders ──────────────────────
 * The partner-scoped order list. Seeded through the real checkout + payment
 * routes (not a repository backdoor) so `grandTotalPaise`, `status` and
 * `ticketCount` are the values the production pipeline actually produces.
 */

function memoryProvider(): MemoryPaymentProvider {
  const provider = createV2Services().paymentProvider;
  if (!(provider instanceof MemoryPaymentProvider)) {
    throw new Error('expected the memory payment provider under STORAGE_DRIVER=memory');
  }
  return provider;
}

/** Seeds org -> venue -> event -> tier -> hold -> paid order. */
async function seedPaidOrder(server: Server): Promise<{ org: string; orderId: string }> {
  seedVerifiedCheckoutUsers(['user_1']);
  const org = await seedOrganization(server);
  const venue = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'Sky Bar', slug: `sky-bar-${++keySeq}` },
  });
  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: { title: 'Sky Night', venueId: venue.json().id, startAt: '2026-09-01T18:00:00Z' },
  });
  const eventId: string = event.json().id;
  await publishEventForTest(eventId);
  const tier = await server.inject({
    method: 'POST',
    url: `/events/${eventId}/ticket-tiers`,
    headers: write(org),
    payload: { name: 'General', priceInPaise: 150_000, quantity: 100 },
  });
  const hold = await server.inject({
    method: 'POST',
    url: '/checkout/holds',
    headers: { 'idempotency-key': `hold-${++keySeq}` },
    payload: { eventId, lines: [{ tierId: tier.json().id, quantity: 2 }] },
  });
  const grandTotalPaise: number = hold.json().pricing.grandTotalPaise;
  const attempt = await server.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { 'idempotency-key': `attempt-${++keySeq}` },
    payload: { holdId: hold.json().holdId },
  });
  const paymentId = `pay_finance_${++keySeq}`;
  const provider = memoryProvider();
  provider.simulateCapture(paymentId, grandTotalPaise, attempt.json().paymentIntentId);
  const verify = await server.inject({
    method: 'POST',
    url: `/payments/${paymentId}/verify`,
    payload: {
      holdId: hold.json().holdId,
      paymentIntentId: attempt.json().paymentIntentId,
      signature: provider.generateSignature({
        paymentId,
        orderId: attempt.json().paymentIntentId,
      }),
    },
  });
  return { org, orderId: verify.json().order.id as string };
}

const listOrders = (server: Server, org: string) =>
  server.inject({
    method: 'GET',
    url: `/organizations/${org}/finance/orders`,
    headers: { 'x-organization-id': org },
  });

describe('GET /organizations/:organizationId/finance/orders', () => {
  it('lists the org orders with the event name resolved server-side', async () => {
    const server = await buildServer();
    const { org, orderId } = await seedPaidOrder(server);

    const res = await listOrders(server, org);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: orderId,
      // Denormalized server-side: the table's Event column must not need a
      // second client-side lookup to fill.
      eventName: 'Sky Night',
      ticketCount: 2,
      status: 'paid',
      currency: 'INR',
      refundedPaise: 0,
    });
    expect(body.pageInfo.total).toBe(1);
    expect(body.pageInfo.hasNextPage).toBe(false);
    await server.close();
  });

  it('carries the buyer name but never their contact details', async () => {
    const server = await buildServer();
    const { org } = await seedPaidOrder(server);

    const row = (await listOrders(server, org)).json().items[0];

    expect(typeof row.buyerName).toBe('string');
    // The narrowing is the point of this DTO: `order.contact.email`/`.phone`
    // exist on the aggregate and must not ride along to a money screen.
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('phone');
    expect(row).not.toHaveProperty('contact');
    await server.close();
  });

  it('omits the pricing breakdown and payment intent id', async () => {
    const server = await buildServer();
    const { org } = await seedPaidOrder(server);

    const row = (await listOrders(server, org)).json().items[0];

    expect(row).not.toHaveProperty('pricing');
    expect(row).not.toHaveProperty('lines');
    expect(row).not.toHaveProperty('paymentIntentId');
    await server.close();
  });

  it('returns an empty page for an org with no orders', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const res = await listOrders(server, org);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [],
      pageInfo: { page: 0, pageSize: 20, total: 0, hasNextPage: false },
    });
    await server.close();
  });

  it('does not leak one org orders to another org in the same test process', async () => {
    const server = await buildServer();
    const { org: sellingOrg } = await seedPaidOrder(server);
    const emptyOrg = await seedOrganization(server);

    const res = await listOrders(server, emptyOrg);

    // The route is `:organizationId`-scoped through `listByOrganization`, so
    // a second org sees an empty desk rather than a neighbour's revenue.
    expect(res.json().items).toHaveLength(0);
    expect(res.json().pageInfo.total).toBe(0);
    // Sanity: the seller's own list is non-empty, so this is scoping and not
    // an empty-fixture artefact.
    expect((await listOrders(server, sellingOrg)).json().items).toHaveLength(1);
    await server.close();
  });

  it('rejects a cross-tenant order list as forbidden', async () => {
    const server = await buildServer();
    await seedPaidOrder(server);
    const other = await seedOrganization(server);

    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${other}/finance/orders`,
      headers: { 'x-organization-id': 'org_seed' },
    });

    expect(res.statusCode).toBe(403);
    await server.close();
  });
});
