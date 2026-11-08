import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, Order } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminFinanceControlRoutes from './finance-controls.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin tax rules + payment reconciliation over HTTP ──────────────────────
 * The guardrails live in the domain (see tax-rule.test.ts); these tests pin that
 * they hold through the real routes: who may call, the two-person rule, replays,
 * and that reconciliation reads what the webhook recorded.
 */

const services = createV2Services();
let keySeq = 0;
let server: FastifyInstance;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

const as = (userId: string, key = `key-${++keySeq}`) => ({
  'x-user-id': userId,
  'idempotency-key': key,
});

const draft = {
  kind: 'tds_194o',
  rateBps: 10,
  basis: 'net_payable_to_seller',
  effectiveFrom: '2026-04-01',
};

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.taxRules as unknown as { rules: Map<string, unknown> }).rules.clear();
  (repos.providerPayments as unknown as { payments: Map<string, unknown> }).payments.clear();
  server = await buildPartnerTestServer({ routes: [adminFinanceControlRoutes] });
  await seedAdmin('author', 'finance');
  await seedAdmin('checker', 'super');
  await seedAdmin('ops_user', 'ops');
});

async function createRule(userId = 'author') {
  const response = await server.inject({
    method: 'POST',
    url: '/admin/tax-rules',
    headers: as(userId),
    payload: draft,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe('tax rules over HTTP', () => {
  it('drafts a rule that is not enabled and has no approval', async () => {
    const rule = await createRule();

    expect(rule).toMatchObject({
      status: 'draft',
      approvalRef: null,
      kind: 'tds_194o',
      rateBps: 10,
      createdBy: 'author',
    });
  });

  it('enables a draft when a different admin cites written advice', async () => {
    const rule = await createRule();

    const response = await server.inject({
      method: 'POST',
      url: `/admin/tax-rules/${rule.id}/enable`,
      headers: as('checker'),
      payload: { approvalRef: 'CA letter dated 5 Oct 2026' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'enabled',
      approvalRef: 'CA letter dated 5 Oct 2026',
      enabledBy: 'checker',
    });
    expect((await services.taxRules.activeRule('tds_194o'))?.id).toBe(rule.id);
  });

  it('refuses the author enabling their own rule, and leaves it a draft', async () => {
    const rule = await createRule();

    const response = await server.inject({
      method: 'POST',
      url: `/admin/tax-rules/${rule.id}/enable`,
      headers: as('author'),
      payload: { approvalRef: 'CA letter dated 5 Oct 2026' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(await services.taxRules.activeRule('tds_194o')).toBeNull();
  });

  it('rejects an enable request with no advice reference before touching the rule', async () => {
    const rule = await createRule();

    for (const payload of [{}, { approvalRef: '' }, { approvalRef: 'ok' }]) {
      const response = await server.inject({
        method: 'POST',
        url: `/admin/tax-rules/${rule.id}/enable`,
        headers: as('checker'),
        payload,
      });
      expect(response.statusCode).toBe(422);
    }
    expect(await services.taxRules.activeRule('tds_194o')).toBeNull();
  });

  it('rejects out-of-range rates, bad dates and unknown kinds', async () => {
    for (const payload of [
      { ...draft, rateBps: 10_001 },
      { ...draft, rateBps: 1.5 },
      { ...draft, effectiveFrom: '1 April 2026' },
      { ...draft, kind: 'cess' },
      { ...draft, extra: true },
    ]) {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/tax-rules',
        headers: as('author'),
        payload,
      });
      expect(response.statusCode).toBe(422);
    }
  });

  it('keeps ops and non-admins out of every tax route', async () => {
    const rule = await createRule();
    const attempts = [
      server.inject({
        method: 'POST',
        url: '/admin/tax-rules',
        headers: as('ops_user'),
        payload: draft,
      }),
      server.inject({
        method: 'POST',
        url: `/admin/tax-rules/${rule.id}/enable`,
        headers: as('ops_user'),
        payload: { approvalRef: 'CA letter dated 5 Oct 2026' },
      }),
      server.inject({
        method: 'POST',
        url: `/admin/tax-rules/${rule.id}/retire`,
        headers: as('ops_user'),
        payload: { reason: 'nope' },
      }),
      server.inject({
        method: 'POST',
        url: '/admin/tax-rules',
        headers: as('stranger'),
        payload: draft,
      }),
      server.inject({ method: 'GET', url: '/admin/tax-rules', headers: as('stranger') }),
    ];

    for (const response of await Promise.all(attempts)) {
      expect([401, 403]).toContain(response.statusCode);
    }
  });

  it('requires an Idempotency-Key and replays the same request without creating a second rule', async () => {
    const missing = await server.inject({
      method: 'POST',
      url: '/admin/tax-rules',
      headers: { 'x-user-id': 'author' },
      payload: draft,
    });
    expect(missing.statusCode).toBe(422);

    const first = await server.inject({
      method: 'POST',
      url: '/admin/tax-rules',
      headers: as('author', 'same-key'),
      payload: draft,
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/admin/tax-rules',
      headers: as('author', 'same-key'),
      payload: draft,
    });

    expect(replay.json().id).toBe(first.json().id);
    const list = await server.inject({
      method: 'GET',
      url: '/admin/tax-rules',
      headers: as('checker'),
    });
    expect(list.json().items).toHaveLength(1);
  });

  it('retires an enabled rule, after which no rate applies', async () => {
    const rule = await createRule();
    await server.inject({
      method: 'POST',
      url: `/admin/tax-rules/${rule.id}/enable`,
      headers: as('checker'),
      payload: { approvalRef: 'CA letter dated 5 Oct 2026' },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/admin/tax-rules/${rule.id}/retire`,
      headers: as('checker'),
      payload: { reason: 'Superseded by revised advice' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('retired');
    expect(await services.taxRules.activeRule('tds_194o')).toBeNull();
  });

  it('lists all rules, or only one kind', async () => {
    await createRule();
    await server.inject({
      method: 'POST',
      url: '/admin/tax-rules',
      headers: as('author'),
      payload: { ...draft, kind: 'gst_tcs_s52', basis: 'gross_sales' },
    });

    const all = await server.inject({
      method: 'GET',
      url: '/admin/tax-rules',
      headers: as('checker'),
    });
    const one = await server.inject({
      method: 'GET',
      url: '/admin/tax-rules?kind=gst_tcs_s52',
      headers: as('checker'),
    });

    expect(all.json().items).toHaveLength(2);
    expect(one.json().items.map((r: { kind: string }) => r.kind)).toEqual(['gst_tcs_s52']);
  });

  it('answers 404 for an unknown rule', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/tax-rules/rule_missing/enable',
      headers: as('checker'),
      payload: { approvalRef: 'CA letter dated 5 Oct 2026' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('reconciliation over HTTP', () => {
  const order = {
    id: 'ORD-recon-1',
    paymentId: 'pay_recon_http',
    grandTotalPaise: 118_000,
    currency: 'INR',
    refundedPaise: 0,
    version: 1,
  } as unknown as Order; // reconciliation reads only these fields; `version` satisfies the store

  const capture = {
    type: 'captured' as const,
    paymentId: 'pay_recon_http',
    providerOrderId: 'order_p',
    orderId: 'ORD-recon-1',
    amountPaise: 118_000,
    currency: 'INR',
    feePaise: 2_360,
    taxOnFeePaise: 425,
    occurredAt: new Date().toISOString(),
  };

  it('reports a reconciled order and the provider’s net', async () => {
    await services.repos().orders.save(order);
    await services.providerPayments.recordEvent(capture);

    const response = await server.inject({
      method: 'GET',
      url: '/admin/finance/reconciliation/ORD-recon-1',
      headers: as('ops_user'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      orderId: 'ORD-recon-1',
      paymentId: 'pay_recon_http',
      reconciled: true,
      findings: [],
      providerNetPaise: 118_000 - 2_360 - 425,
    });
  });

  it('reports what differs: a refund the provider made that the order lacks', async () => {
    await services
      .repos()
      .orders.save({ ...order, id: 'ORD-recon-2', paymentId: 'pay_recon_http' });
    await services.providerPayments.recordEvent(capture);
    await services.providerPayments.recordEvent({
      type: 'refund_processed',
      paymentId: 'pay_recon_http',
      refundId: 'rfnd_1',
      amountPaise: 5_000,
      currency: 'INR',
    });

    const response = await server.inject({
      method: 'GET',
      url: '/admin/finance/reconciliation/ORD-recon-2',
      headers: as('ops_user'),
    });

    expect(response.json()).toMatchObject({
      reconciled: false,
      findings: [{ kind: 'refund_mismatch', ourPaise: 0, providerPaise: 5_000 }],
    });
  });

  it('reports a missing provider record, 404s an unknown order, and refuses non-admins', async () => {
    await services
      .repos()
      .orders.save({ ...order, id: 'ORD-recon-3', paymentId: 'pay_never_seen' });

    const missing = await server.inject({
      method: 'GET',
      url: '/admin/finance/reconciliation/ORD-recon-3',
      headers: as('ops_user'),
    });
    expect(missing.json()).toMatchObject({
      reconciled: false,
      findings: [{ kind: 'provider_record_missing' }],
      providerNetPaise: null,
    });

    const unknown = await server.inject({
      method: 'GET',
      url: '/admin/finance/reconciliation/ORD-nope',
      headers: as('ops_user'),
    });
    expect(unknown.statusCode).toBe(404);

    const stranger = await server.inject({
      method: 'GET',
      url: '/admin/finance/reconciliation/ORD-recon-3',
      headers: as('stranger'),
    });
    expect([401, 403]).toContain(stranger.statusCode);
  });
});
