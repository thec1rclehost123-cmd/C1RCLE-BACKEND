import { createPlatformAdmin, DEFAULT_JOURNAL_TRANSITION_STATE } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ReconciliationDiscrepancy } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminReconciliationRoutes from './reconciliation.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
let sequence = 0;
let server: FastifyInstance;

function headers(key = `recon-${++sequence}`, userId = 'admin_finance') {
  return { 'x-user-id': userId, 'idempotency-key': key };
}

beforeEach(async () => {
  const repositories = services.repos();
  (repositories.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (
    repositories.reconciliations as unknown as {
      runs: Map<string, unknown>;
      discrepancies: Map<string, unknown>;
    }
  ).runs.clear();
  (
    repositories.reconciliations as unknown as {
      runs: Map<string, unknown>;
      discrepancies: Map<string, unknown>;
    }
  ).discrepancies.clear();
  (repositories.providerPayments as unknown as { payments: Map<string, unknown> }).payments.clear();
  (repositories.proposals as unknown as { proposals: Map<string, unknown> }).proposals.clear();
  const journalRepo = repositories.financialJournals as unknown as {
    journals: Map<string, unknown>;
    byIdempotencyKey: Map<string, unknown>;
  };
  journalRepo.journals.clear();
  journalRepo.byIdempotencyKey.clear();
  (
    repositories.journalTransition as unknown as {
      state: typeof DEFAULT_JOURNAL_TRANSITION_STATE;
    }
  ).state = {
    ...DEFAULT_JOURNAL_TRANSITION_STATE,
    phase: 'journal_reads',
    readModel: 'financial_journal_v2',
  };
  await repositories.platformAdmins.save(
    createPlatformAdmin({
      id: 'admin_finance',
      email: 'finance@c1rcle.test',
      role: 'finance',
    }),
  );
  await repositories.platformAdmins.save(
    createPlatformAdmin({ id: 'admin_super_1', email: 'one@c1rcle.test', role: 'super' }),
  );
  await repositories.platformAdmins.save(
    createPlatformAdmin({ id: 'admin_super_2', email: 'two@c1rcle.test', role: 'super' }),
  );
  server = await buildPartnerTestServer({ routes: [adminReconciliationRoutes] });
});

describe('admin reconciliation routes', () => {
  it('posts an approved dual-control adjustment exactly once', async () => {
    const proposal = await services.adminAuthority.propose('admin_super_1', {
      action: 'FINANCIAL_ADJUSTMENT',
      reason: 'Correct verified partner allocation',
      payload: { organizationId: 'org-adjusted', amountPaise: 12_500, direction: 'credit' },
    });
    await services.adminAuthority.approve('admin_super_2', proposal.id, 'Evidence checked');
    const key = `adjust-${++sequence}`;
    const first = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposal.id}/post-financial-adjustment`,
      headers: headers(key, 'admin_super_1'),
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposal.id}/post-financial-adjustment`,
      headers: headers(key, 'admin_super_1'),
    });
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const journals = await services
      .repos()
      .financialJournals.findBySource('manual_adjustment', proposal.id);
    expect(journals).toHaveLength(1);
    expect(journals[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: 'partner_payable',
          side: 'credit',
          amountPaise: 12_500,
        }),
      ]),
    );
  });

  it('refuses to post an adjustment while legacy balance reads are active', async () => {
    (
      services.repos().journalTransition as unknown as {
        state: typeof DEFAULT_JOURNAL_TRANSITION_STATE;
      }
    ).state = { ...DEFAULT_JOURNAL_TRANSITION_STATE };
    const proposal = await services.adminAuthority.propose('admin_super_1', {
      action: 'FINANCIAL_ADJUSTMENT',
      reason: 'Should remain invisible before cutover',
      payload: { organizationId: 'org-adjusted', amountPaise: 12_500, direction: 'credit' },
    });
    await services.adminAuthority.approve('admin_super_2', proposal.id, 'Evidence checked');

    const response = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposal.id}/post-financial-adjustment`,
      headers: headers(`adjust-legacy-${++sequence}`, 'admin_super_1'),
    });

    expect(response.statusCode).toBe(400);
    expect(
      await services.repos().financialJournals.findBySource('manual_adjustment', proposal.id),
    ).toEqual([]);
  });

  it('lists privacy-minimized provider chargeback cases', async () => {
    const now = new Date().toISOString();
    await services.repos().providerPayments.save({
      id: 'pay_chargeback_1',
      provider: 'razorpay',
      providerOrderId: 'order_provider_1',
      orderId: null,
      processingState: 'requires_support',
      currency: 'INR',
      capturedPaise: 10_000,
      feePaise: 0,
      taxOnFeePaise: 0,
      capturedAt: now,
      refunds: {},
      disputes: {
        'disp-1': {
          amountPaise: 10_000,
          amountDeductedPaise: 0,
          status: 'open',
          reasonCode: 'fraudulent',
          reasonDescription: null,
          respondBy: now,
          phase: 'chargeback',
          evidenceState: 'none',
          providerOccurredAt: now,
        },
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/admin/chargebacks?limit=20',
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({
        disputeId: 'disp-1',
        paymentId: 'pay_chargeback_1',
        amountPaise: 10_000,
        status: 'open',
      }),
    ]);
    expect(JSON.stringify(response.json())).not.toContain('email');
  });

  it('runs idempotently and exposes run status', async () => {
    const key = `run-${++sequence}`;
    const first = await server.inject({
      method: 'POST',
      url: '/admin/reconciliation/runs',
      headers: headers(key),
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/admin/reconciliation/runs',
      headers: headers(key),
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);

    const list = await server.inject({
      method: 'GET',
      url: '/admin/reconciliation/runs?limit=20',
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    const get = await server.inject({
      method: 'GET',
      url: `/admin/reconciliation/runs/${first.json().id}`,
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().status).toBe('completed');
  });

  it('reads, rechecks, resolves and exports discrepancy evidence idempotently', async () => {
    const now = new Date().toISOString();
    const discrepancy: ReconciliationDiscrepancy = {
      id: `recon-item-${++sequence}`,
      runId: 'recon-run-seeded',
      kind: 'captured_payment_without_order',
      state: 'finance_review',
      organizationId: null,
      orderId: null,
      paymentId: 'pay_redacted_reference',
      payoutId: null,
      amountPaise: 1_000,
      currency: 'INR',
      evidence: { providerPaymentPresent: true, orderPresent: false },
      repair: 'recheck_evidence',
      resolutionReason: null,
      resolvedBy: null,
      resolvedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await services.repos().reconciliations.createDiscrepancies([discrepancy]);

    const list = await server.inject({
      method: 'GET',
      url: '/admin/reconciliation/discrepancies?limit=20',
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].id).toBe(discrepancy.id);

    const detail = await server.inject({
      method: 'GET',
      url: `/admin/reconciliation/discrepancies/${discrepancy.id}`,
      headers: headers(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().evidence).toEqual(discrepancy.evidence);

    const retryKey = `retry-${++sequence}`;
    const retry = await server.inject({
      method: 'POST',
      url: `/admin/reconciliation/discrepancies/${discrepancy.id}/retry`,
      headers: headers(retryKey),
    });
    const retryReplay = await server.inject({
      method: 'POST',
      url: `/admin/reconciliation/discrepancies/${discrepancy.id}/retry`,
      headers: headers(retryKey),
    });
    expect(retry.statusCode).toBe(201);
    expect(retryReplay.json().id).toBe(retry.json().id);

    const resolveKey = `resolve-${++sequence}`;
    const resolve = await server.inject({
      method: 'POST',
      url: `/admin/reconciliation/discrepancies/${discrepancy.id}/resolve`,
      headers: headers(resolveKey),
      payload: { reason: 'Provider evidence reviewed' },
    });
    const resolveReplay = await server.inject({
      method: 'POST',
      url: `/admin/reconciliation/discrepancies/${discrepancy.id}/resolve`,
      headers: headers(resolveKey),
      payload: { reason: 'Provider evidence reviewed' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().state).toBe('resolved');
    expect(resolveReplay.json()).toEqual(resolve.json());

    const exported = await server.inject({
      method: 'GET',
      url: '/admin/reconciliation/export.csv',
      headers: headers(),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body).toContain(discrepancy.id);
  });
});
