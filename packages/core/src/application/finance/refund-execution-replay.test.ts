import { describe, expect, it, vi } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createPlatformAdmin } from '../../domain/models/admin-authority.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { createEvent } from '../../domain/models/event.js';
import { createLedgerEntry } from '../../domain/models/ledger.js';
import { createOrder } from '../../domain/models/order.js';
import { applyProviderPaymentEvent } from '../../domain/models/provider-payment.js';
import { MemoryPaymentProvider } from '../../domain/ports/payment-provider.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { buildRepositories } from '../../infrastructure/utils.js';
import { noopLogger } from '../../telemetry/logger.js';
import { AdminAuthorityService } from '../admin/admin-authority-service.js';

import { FinancialPostingService } from './financial-posting-service.js';
import { RefundService } from './refund-service.js';

import type { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import type { ServiceDeps } from '../context.js';

async function fixture(amountPaise = 1000, omitOriginalAccounting = false) {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const config = createCoreConfig({
    redis: { url: 'redis://localhost:6379' },
    firestore: { projectId: 'test-refund-replay' },
    clock: { now: () => now },
  });
  const repositories = buildRepositories({
    STORAGE_DRIVER: 'memory',
    FIRESTORE_PROJECT_ID: 'test-refund-replay',
  });
  const outbox = new MemoryOutboxStore();
  const adminAudit = new MemoryAdminAuditRepository();
  const paymentProvider = new MemoryPaymentProvider('synthetic-only');
  const deps = {
    config,
    repositories,
    outbox,
    adminAudit,
    paymentProvider,
    logger: noopLogger,
  } as unknown as ServiceDeps;
  await repositories.platformAdmins.save(
    createPlatformAdmin({
      id: 'ADMIN-original',
      email: 'original@synthetic.test',
      role: 'finance',
      now,
    }),
  );
  await repositories.platformAdmins.save(
    createPlatformAdmin({
      id: 'ADMIN-recovery',
      email: 'recovery@synthetic.test',
      role: 'ops',
      now,
    }),
  );
  const event = createEvent({
    id: 'EVT-refund-replay',
    organizationId: 'ORG-refund-replay',
    venueId: 'VEN-local',
    title: 'Synthetic refund replay',
    startAt: '2026-12-01T12:00:00Z',
    now,
  });
  await repositories.events.save(event);
  const order = {
    ...createOrder({
      id: 'ORD-refund-replay',
      eventId: event.id,
      organizationId: event.organizationId,
      userId: 'USR-local',
      contact: { name: 'Local Guest', email: 'local@example.test', phone: '' },
      pricing: {
        currency: 'INR',
        lines: [
          {
            tierId: 'TIER-local',
            tierName: 'General',
            quantity: 1,
            unitPricePaise: 1000,
            subtotalPaise: 1000,
          },
        ],
        subtotalPaise: 1000,
        discountPaise: 0,
        discountedSubtotalPaise: 1000,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        gstPaise: 0,
        grandTotalPaise: 1000,
        appliedPromoCode: null,
      },
      now,
    }),
    status: 'paid' as const,
    paymentId: 'pay-refund-replay',
    paymentIntentId: 'order-refund-replay',
    paidAt: now.toISOString(),
  };
  await repositories.orders.save(order);
  const tickets = issueEntitlements({ order, now });
  await repositories.entitlements.saveMany(tickets);
  paymentProvider.simulateCapture(order.paymentId, 1000, order.paymentIntentId);
  await repositories.providerPayments.save(
    applyProviderPaymentEvent(
      null,
      {
        type: 'captured',
        paymentId: order.paymentId,
        providerOrderId: order.paymentIntentId,
        orderId: order.id,
        correlated: true,
        amountPaise: 1000,
        currency: 'INR',
        feePaise: 0,
        taxOnFeePaise: 0,
        occurredAt: now.toISOString(),
      },
      now,
    ),
  );
  if (!omitOriginalAccounting)
    await new FinancialPostingService(repositories.financialJournals).postTicketSale({
      organizationId: order.organizationId,
      orderId: order.id,
      eventId: order.eventId,
      paymentId: order.paymentId,
      sourceType: 'online_payment_capture',
      providerConfirmed: true,
      currency: order.currency,
      ticketFaceValuePaise: 1000,
      discountPaise: 0,
      discountFundingOwner: null,
      netTicketRevenuePaise: 1000,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      gstPaise: 0,
      providerFeePaise: 0,
      allocation: {
        platformPaise: 0,
        hostOrganizationId: order.organizationId,
        hostPaise: 1000,
        venueOrganizationId: null,
        venuePaise: 0,
        promoterOrganizationId: null,
        promoterPaise: 0,
      },
      postedAt: now,
    });
  const authority = new AdminAuthorityService(deps);
  const service = new RefundService(deps, authority);
  const { request } = await service.requestRefund('ADMIN-original', {
    orderId: order.id,
    amountPaise,
    reason: 'Synthetic refund retry',
    targetEntitlementIds: tickets.map((ticket) => ticket.id),
    intakeKey: 'refund-replay-intake',
  });
  return {
    deps,
    repositories,
    outbox,
    adminAudit,
    paymentProvider,
    service,
    request,
    order,
    tickets,
    now,
  };
}

describe('Refund execution repairs settled notification and audit intents', () => {
  it('repairs original sale accounting before refunding a cancellation-locked staged purchase without issuing rights or duplicating money', async () => {
    const f = await fixture(1000, true);
    const stored = await f.repositories.orders.getById(f.order.id);
    if (!stored) throw new Error('Missing refund-locked order');
    const allocation = {
      version: 'sale-allocation-v1' as const,
      grossPaise: 1000,
      platformPaise: 0,
      hostPaise: 1000,
      venuePaise: 0,
      promoterPaise: 0,
      hostOrganizationId: f.order.organizationId,
      venueOrganizationId: f.order.organizationId,
      promoterOrganizationId: null,
      partnershipId: null,
      partnershipVersion: null,
      onboardingId: null,
      onboardingVersion: null,
      capturedAt: f.now.toISOString(),
    };
    await f.repositories.orders.save({
      ...stored,
      fulfillmentState: 'pending',
      saleAllocation: allocation,
      version: stored.version + 1,
    });
    const event = await f.repositories.events.getById(f.order.eventId);
    if (!event) throw new Error('Missing event');
    await f.repositories.events.save({ ...event, status: 'cancelled', version: event.version + 1 });
    const journals = f.repositories.financialJournals as MemoryFinancialJournalRepository;
    // Only the first original compatibility leg survived. Its later status/version must be preserved.
    const originalLeg = {
      ...createLedgerEntry({
        id: 'LED-original-revenue',
        orderId: f.order.id,
        eventId: f.order.eventId,
        organizationId: f.order.organizationId,
        entryType: 'ticket_revenue',
        amount: 1000,
        status: 'settled',
        idempotencyKey: 'original-sale-revenue',
        now: f.now,
      }),
      version: 4,
    };
    await f.repositories.ledger.createBatch([originalLeg]);
    const ticketsBefore = await f.repositories.entitlements.getByOrderId(f.order.id);
    const issue = vi.spyOn(f.repositories.entitlements, 'save');
    const provider = vi.spyOn(f.paymentProvider, 'refundPayment');
    provider.mockImplementationOnce(async (input) => {
      expect(await journals.findByOrderId(f.order.id)).toHaveLength(2);
      expect(await f.repositories.entitlements.getByOrderId(f.order.id)).toEqual(ticketsBefore);
      return {
        id: 'rfnd-sale-repair',
        status: 'processed',
        amountPaise: input.amountPaise ?? 1000,
      };
    });
    const result = await f.service.executeRefund('ADMIN-original', f.request.id);
    expect(result.request.status).toBe('settled');
    expect(
      (await f.repositories.ledger.findByOrder(f.order.id)).find(
        (row) => row.id === originalLeg.id,
      ),
    ).toEqual(originalLeg);
    expect(
      (await f.repositories.ledger.findByOrder(f.order.id)).filter(
        (row) => row.entryType !== 'refund',
      ),
    ).toHaveLength(4);
    expect(
      (await f.repositories.entitlements.getByOrderId(f.order.id)).map((ticket) => ticket.id),
    ).toEqual(ticketsBefore.map((ticket) => ticket.id));
    expect(issue.mock.calls.every(([ticket]) => ticket.status === 'void')).toBe(true);
    const journalCount = (await journals.findByOrderId(f.order.id)).length;
    await f.service.executeRefund('ADMIN-recovery', f.request.id);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await journals.findByOrderId(f.order.id)).toHaveLength(journalCount);
  });

  it.each(['none', 'partial'] as const)(
    'blocks ambiguous legacy %s allocation evidence before provider refund and records durable finance review',
    async (evidence) => {
      const f = await fixture(1000, true);
      if (evidence === 'partial')
        await f.repositories.ledger.createBatch([
          createLedgerEntry({
            id: 'LED-legacy-only',
            orderId: f.order.id,
            eventId: f.order.eventId,
            organizationId: f.order.organizationId,
            entryType: 'ticket_revenue',
            amount: 1000,
            status: 'settled',
            idempotencyKey: 'legacy-only',
            now: f.now,
          }),
        ]);
      const provider = vi.spyOn(f.paymentProvider, 'refundPayment');
      await expect(f.service.executeRefund('ADMIN-original', f.request.id)).rejects.toThrow(
        /original sale|allocation|accounting/i,
      );
      expect(provider).not.toHaveBeenCalled();
      expect(await f.repositories.orders.getById(f.order.id)).toMatchObject({
        status: 'refund_requested',
      });
      const findings = await f.repositories.reconciliations.listDiscrepancies({
        limit: 100,
        cursor: null,
      });
      expect(findings.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'finance_review', orderId: f.order.id }),
        ]),
      );
    },
  );

  it.each(['outbox', 'audit'] as const)(
    'repairs interrupted %s on settled retry using original execution attribution without repeating money or admission effects',
    async (failure) => {
      const f = await fixture();
      const refund = vi.spyOn(f.paymentProvider, 'refundPayment');
      let armed = true;
      const appendEvent = f.outbox.append.bind(f.outbox);
      const appendAudit = f.adminAudit.append.bind(f.adminAudit);
      vi.spyOn(f.outbox, 'append').mockImplementation(async (event) => {
        if (failure === 'outbox' && armed && event.type === 'finance.refund.settled') {
          armed = false;
          throw new Error('Synthetic after-settled outbox failure');
        }
        await appendEvent(event);
      });
      vi.spyOn(f.adminAudit, 'append').mockImplementation(async (record) => {
        if (failure === 'audit' && armed && record.action === 'FINANCIAL_REFUND.execute') {
          armed = false;
          throw new Error('Synthetic after-settled audit failure');
        }
        await appendAudit(record);
      });
      await expect(
        f.service.executeRefund('ADMIN-original', f.request.id, {
          ipAddress: '127.0.0.10',
          userAgent: 'synthetic-original',
        }),
      ).rejects.toThrow(/after-settled/);
      expect((await f.repositories.refundRequests.getById(f.request.id))?.status).toBe('settled');
      const orderBefore = await f.repositories.orders.getById(f.order.id);
      const ticketsBefore = await f.repositories.entitlements.getByOrderId(f.order.id);
      const journalsBefore = await f.repositories.financialJournals.findByOrderId(f.order.id);
      await Promise.all([
        f.service.executeRefund('ADMIN-recovery', f.request.id, {
          ipAddress: '127.0.0.20',
          userAgent: 'synthetic-recovery',
        }),
        f.service.executeRefund('ADMIN-recovery', f.request.id),
      ]);
      const notices = f.outbox.all().filter((row) => row.type === 'finance.refund.settled');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        payload: {
          actorId: 'ADMIN-original',
          payload: { refundRequestId: f.request.id, orderId: f.order.id, amountPaise: 1000 },
        },
      });
      const executionAudits = f.adminAudit
        .all()
        .filter((record) => record.action === 'FINANCIAL_REFUND.execute');
      expect(executionAudits).toHaveLength(1);
      expect(executionAudits[0]).toMatchObject({
        adminId: 'ADMIN-original',
        adminRole: 'finance',
        ipAddress: '127.0.0.10',
        userAgent: 'synthetic-original',
        after: { status: 'settled', executionActorSource: 'execution_claim' },
      });
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await f.repositories.orders.getById(f.order.id)).toEqual(orderBefore);
      expect(await f.repositories.entitlements.getByOrderId(f.order.id)).toEqual(ticketsBefore);
      expect(await f.repositories.financialJournals.findByOrderId(f.order.id)).toEqual(
        journalsBefore,
      );
    },
  );
  it('labels legacy settled recovery truthfully and still requires current admin authorization', async () => {
    const f = await fixture();
    const refund = vi.spyOn(f.paymentProvider, 'refundPayment');
    const append = f.outbox.append.bind(f.outbox);
    let armed = true;
    vi.spyOn(f.outbox, 'append').mockImplementation(async (event) => {
      if (armed && event.type === 'finance.refund.settled') {
        armed = false;
        throw new Error('Synthetic legacy settlement interruption');
      }
      await append(event);
    });
    await expect(f.service.executeRefund('ADMIN-original', f.request.id)).rejects.toThrow(
      /legacy settlement interruption/,
    );
    const settled = await f.repositories.refundRequests.getById(f.request.id);
    if (!settled) throw new Error('Missing settled fixture');
    const legacy = { ...settled, version: settled.version + 1 };
    delete legacy.executionActor;
    delete legacy.settlementAudit;
    await f.repositories.refundRequests.save(legacy);
    const before = await f.repositories.orders.getById(f.order.id);
    await expect(f.service.executeRefund('USR-not-an-admin', f.request.id)).rejects.toThrow(
      /Platform admin authority/,
    );
    expect(
      f.adminAudit.all().filter((record) => record.action === 'FINANCIAL_REFUND.execute'),
    ).toHaveLength(0);
    await Promise.all([
      f.service.executeRefund('ADMIN-recovery', f.request.id),
      f.service.executeRefund('ADMIN-recovery', f.request.id),
    ]);
    const audits = f.adminAudit
      .all()
      .filter((record) => record.action === 'FINANCIAL_REFUND.execute');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      adminId: 'ADMIN-recovery',
      adminRole: 'ops',
      before: { status: 'unknown', orderStatus: 'unknown' },
      after: { status: 'settled', executionActorSource: 'legacy_recovery' },
    });
    expect(
      (await f.repositories.refundRequests.getById(f.request.id))?.executionActor,
    ).toMatchObject({ adminId: 'ADMIN-recovery', source: 'legacy_recovery' });
    expect(f.outbox.all().filter((row) => row.type === 'finance.refund.settled')).toHaveLength(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(await f.repositories.orders.getById(f.order.id)).toEqual(before);
  });
  it('returns the canonical order after an inline consumer starts a remaining-balance review', async () => {
    const f = await fixture(500);
    const refund = vi.spyOn(f.paymentProvider, 'refundPayment');
    const append = f.outbox.append.bind(f.outbox);
    vi.spyOn(f.outbox, 'append').mockImplementation(async (event) => {
      await append(event);
      if (event.type === 'finance.refund.settled' && event.aggregateId === f.request.id) {
        await f.service.requestRefund('ADMIN-recovery', {
          orderId: f.order.id,
          amountPaise: 500,
          reason: 'Synthetic remaining-balance review',
          intakeKey: 'remaining-refund-review',
        });
      }
    });
    const result = await f.service.executeRefund('ADMIN-original', f.request.id);
    expect(result.request.status).toBe('settled');
    expect(result.order).toEqual(await f.repositories.orders.getById(f.order.id));
    expect(result.order).toMatchObject({ status: 'refund_requested', refundedPaise: 500 });
    expect(result.order.appliedRefundRequestIds).toEqual([f.request.id]);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(await f.repositories.refundRequests.listByOrder(f.order.id)).toHaveLength(2);
  });
});
