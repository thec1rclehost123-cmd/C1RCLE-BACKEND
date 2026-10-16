import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ReconciliationDiscrepancy } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminReconciliationRoutes from './reconciliation.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
let sequence = 0;
let server: FastifyInstance;

function headers(key = `recon-${++sequence}`) {
  return { 'x-user-id': 'admin_finance', 'idempotency-key': key };
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
  await repositories.platformAdmins.save(
    createPlatformAdmin({
      id: 'admin_finance',
      email: 'finance@c1rcle.test',
      role: 'finance',
    }),
  );
  server = await buildPartnerTestServer({ routes: [adminReconciliationRoutes] });
});

describe('admin reconciliation routes', () => {
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
