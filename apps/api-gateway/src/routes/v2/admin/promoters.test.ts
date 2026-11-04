import {
  applyProviderPaymentEvent,
  calculatePricing,
  createOrder,
  createPlatformAdmin,
  createReferralLink,
  createTicketTier,
} from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, PromoterAssignment } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminPromotersRoutes from './promoters.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin promoters desk over HTTP (Phase 7 admin) ──────────────────────────
 * Platform-wide, read-only promoter-assignment list. Asserts the DTO flattens
 * `terms` into `ratePercent`/`flatPaise` for the desk.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

function assignment(overrides: Partial<PromoterAssignment>): PromoterAssignment {
  const now = new Date().toISOString();
  return {
    id: `pa_${++keySeq}`,
    eventId: 'event_1',
    promoterId: 'user_promoter',
    status: 'active',
    terms: { version: 1, ratePercent: 15, flatPaise: 0 },
    version: 1,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    suspendedAt: null,
    suspendedFromStatus: null,
    invitedAt: null,
    invitedBy: null,
    respondedAt: null,
    respondedBy: null,
    acceptedAt: null,
    rejectedAt: null,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    startsAt: null,
    expiresAt: null,
    eligibleTierIds: null,
    ...overrides,
  };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.catalog as unknown as { assignments: Map<string, unknown> }).assignments.clear();
  (repos.referralLinks as unknown as { links: Map<string, unknown> }).links.clear();
  (services.adminAudits() as unknown as { records: unknown[] }).records.length = 0;

  server = await buildPartnerTestServer({ routes: [adminPromotersRoutes] });
});

describe('GET /admin/promoters', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/promoters',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists promoter assignments with flattened commission terms', async () => {
    await seedAdmin('admin_a', 'ops');
    await services.repos().catalog.saveAssignment(assignment({}));

    const response = await server.inject({
      method: 'GET',
      url: '/admin/promoters',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].ratePercent).toBe(15);
    expect(body.items[0].flatPaise).toBe(0);
    expect(body.items[0].status).toBe('active');
  });
});

describe('GET /admin/promoters/:promoterId/referral-links', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/promoters/user_promoter/referral-links',
      headers: asUser('not_an_admin'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns backend link state and bounded activity counters to an admin', async () => {
    await seedAdmin('admin_a', 'ops');
    const link = createReferralLink({
      id: 'referral_1',
      eventId: 'event_1',
      promoterId: 'user_promoter',
      organizationId: 'org_promoter',
      code: 'PROMO123',
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    await services.repos().referralLinks.save({
      ...link,
      isActive: false,
      clicks: 12,
      conversions: 3,
      lastClickedAt: '2026-10-28T12:10:00.000Z',
    });

    const response = await server.inject({
      method: 'GET',
      url: '/admin/promoters/user_promoter/referral-links?limit=25',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toMatchObject([
      {
        id: 'referral_1',
        isActive: false,
        clicks: 12,
        conversions: 3,
        lastClickedAt: '2026-10-28T12:10:00.000Z',
      },
    ]);
    expect(response.json().items[0]).not.toHaveProperty('attributionSignature');
    expect(response.json().items[0]).not.toHaveProperty('termsSnapshot');
  });
});

describe('GET /admin/promoters/:promoterId/risk-flags', () => {
  it('requires Admin authority', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/promoters/org_promoter/risk-flags',
      headers: asUser('not_an_admin'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns active provider disputes only for orders attributed to the selected Promoter', async () => {
    await seedAdmin('admin_a', 'ops');
    const now = new Date('2026-10-28T12:00:00.000Z');
    const tier = createTicketTier({
      id: 'tier_risk_flag',
      eventId: 'event_risk_flag',
      organizationId: 'org_host_risk_flag',
      name: 'General',
      priceInPaise: 10_000,
      quantity: 10,
      now,
    });
    const order = {
      ...createOrder({
        id: 'order_risk_flag',
        eventId: 'event_risk_flag',
        organizationId: 'org_host_risk_flag',
        contact: { name: 'Guest', email: 'guest@example.test', phone: '5550100' },
        pricing: calculatePricing({ lines: [{ tier, quantity: 1 }] }),
        now,
      }),
      status: 'paid' as const,
      paymentId: 'pay_risk_flag',
      attribution: {
        referralLinkId: 'link_risk_flag',
        promoterId: 'org_promoter_risk_flag',
        code: 'RISK123',
        assignmentId: 'assignment_risk_flag',
        assignmentVersion: 1,
        termsSnapshot: { version: 1, ratePercent: 10, flatPaise: 0 },
        eligibleTierIds: null,
        commissionPolicyVersion: 'commission-v1',
        commercialPolicyVersion: 'commercial-v1',
        attributedAt: now.toISOString(),
        attributionSignature: 'test-signature',
        promoterCommissionPaise: 1_000,
      },
    };
    const repositories = services.repos();
    await repositories.orders.save(order);
    const captured = applyProviderPaymentEvent(
      null,
      {
        type: 'captured',
        paymentId: 'pay_risk_flag',
        providerOrderId: 'rorder_risk_flag',
        orderId: order.id,
        correlated: true,
        amountPaise: order.grandTotalPaise,
        currency: 'INR',
        feePaise: 0,
        taxOnFeePaise: 0,
        occurredAt: now.toISOString(),
      },
      now,
    );
    await repositories.providerPayments.save(captured);
    const disputed = applyProviderPaymentEvent(
      captured,
      {
        type: 'dispute',
        paymentId: 'pay_risk_flag',
        disputeId: 'dispute_risk_flag',
        amountPaise: 5_000,
        currency: 'INR',
        status: 'under_review',
        amountDeductedPaise: 0,
        reasonCode: null,
        reasonDescription: null,
        respondBy: null,
        phase: 'chargeback',
        evidenceState: 'none',
        providerOccurredAt: now.toISOString(),
      },
      now,
    );
    await repositories.providerPayments.save(disputed);

    const response = await server.inject({
      method: 'GET',
      url: '/admin/promoters/org_promoter_risk_flag/risk-flags',
      headers: asUser('admin_a'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      promoterId: 'org_promoter_risk_flag',
      complete: true,
      flags: [
        {
          paymentId: 'pay_risk_flag',
          disputeId: 'dispute_risk_flag',
          orderId: 'order_risk_flag',
          eventId: 'event_risk_flag',
          status: 'under_review',
          amountPaise: 5_000,
        },
      ],
    });
    expect(response.json()).not.toHaveProperty('reasonDescription');
  });
});

describe('POST /admin/promoter-links/:linkId/deactivate', () => {
  it('requires Admin authority and records reasoned before/after audit evidence', async () => {
    const link = createReferralLink({
      id: 'referral_to_deactivate',
      eventId: 'event_1',
      promoterId: 'user_promoter',
      organizationId: 'org_promoter',
      code: 'PROMO456',
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    await services.repos().referralLinks.save(link);

    const denied = await server.inject({
      method: 'POST',
      url: '/admin/promoter-links/referral_to_deactivate/deactivate',
      headers: { 'x-user-id': 'not_an_admin', 'idempotency-key': 'deactivate-denied' },
      payload: { reason: 'Confirmed policy violation' },
    });
    expect(denied.statusCode).toBe(401);

    await seedAdmin('admin_a', 'ops');
    const response = await server.inject({
      method: 'POST',
      url: '/admin/promoter-links/referral_to_deactivate/deactivate',
      headers: asUser('admin_a'),
      payload: { reason: 'Confirmed policy violation' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      linkId: 'referral_to_deactivate',
      action: 'deactivated',
      changed: true,
    });
    expect((await services.repos().referralLinks.getById(link.id))?.isActive).toBe(false);
    const audit = await services.adminAudits().listForTarget(link.id, 10);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      adminId: 'admin_a',
      action: 'PROMOTER_LINK_DEACTIVATE',
      targetType: 'referral-link',
      targetId: link.id,
      reason: 'Confirmed policy violation',
      before: { isActive: true, version: 1 },
      after: { isActive: false, version: 2 },
    });
  });
});

describe('POST /admin/promoters/:promoterId/suspend', () => {
  it('refuses a support-tier admin (TIER2 action, F1/F2 regression)', async () => {
    await seedAdmin('admin_support', 'support');
    await services.repos().catalog.saveAssignment(assignment({}));

    const response = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers: asUser('admin_support'),
      payload: { reason: 'Policy review' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('suspends as an ops admin and writes an audit record (F3)', async () => {
    await seedAdmin('admin_a', 'ops');
    await services.repos().catalog.saveAssignment(assignment({}));

    const response = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers: asUser('admin_a'),
      payload: { reason: 'Policy review' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.action).toBe('suspended');
    expect(body.affectedAssignments).toBe(1);

    const audit = await services.adminAudits().listForTarget('user_promoter', 10);
    expect(audit.some((r) => r.action === 'PROMOTER_SUSPEND')).toBe(true);
    expect(audit.find((r) => r.action === 'PROMOTER_SUSPEND')?.reason).toBe('Policy review');
  });

  it('replay of the same audit-free idempotency key does not double-log', async () => {
    await seedAdmin('admin_a', 'ops');
    await services.repos().catalog.saveAssignment(assignment({}));

    const headers = asUser('admin_a');
    const first = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers,
      payload: { reason: 'Policy review' },
    });
    const second = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers,
      payload: { reason: 'Policy review' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const audit = await services.adminAudits().listForTarget('user_promoter', 10);
    expect(audit.filter((r) => r.action === 'PROMOTER_SUSPEND')).toHaveLength(1);
  });

  it('requires a reason before changing Promoter status', async () => {
    await seedAdmin('admin_a', 'ops');
    await services.repos().catalog.saveAssignment(assignment({}));

    const response = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(422);
  });
});
