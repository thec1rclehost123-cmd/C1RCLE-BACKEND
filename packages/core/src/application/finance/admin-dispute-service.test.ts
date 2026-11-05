import { describe, expect, it, vi } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createPlatformAdmin } from '../../domain/models/admin-authority.js';
import { resolveDispute, createDispute } from '../../domain/models/dispute.js';
import {
  createPostedJournal,
  DEFAULT_ACCOUNTING_POLICY,
  journalTotals,
} from '../../domain/models/financial-journal.js';
import { createLedgerEntry } from '../../domain/models/ledger.js';
import { createOrder } from '../../domain/models/order.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { buildRepositories } from '../../infrastructure/utils.js';
import { noopLogger } from '../../telemetry/logger.js';
import { AdminAuthorityService } from '../admin/admin-authority-service.js';

import { AdminDisputeService } from './admin-dispute-service.js';

import type { ServiceDeps } from '../context.js';

async function fixture(
  options: {
    linked?: boolean;
    explicitJournal?: boolean;
    amount?: number;
    foreign?: boolean;
    multiParty?: boolean;
  } = {},
) {
  const repositories = buildRepositories({
    STORAGE_DRIVER: 'memory',
    FIRESTORE_PROJECT_ID: 'test-project',
  });
  const now = new Date('2026-11-04T00:00:00Z');
  const audit = new MemoryAdminAuditRepository();
  const deps = {
    repositories,
    adminAudit: audit,
    config: createCoreConfig({
      firestore: { projectId: 'test-project' },
      redis: { url: 'redis://localhost:6379' },
      clock: { now: () => now },
    }),
    logger: noopLogger,
  } as unknown as ServiceDeps;
  await repositories.platformAdmins.save(
    createPlatformAdmin({ id: 'finance-admin', email: 'admin@example.test', role: 'finance' }),
  );
  await repositories.platformAdmins.save(
    createPlatformAdmin({ id: 'support-admin', email: 'support@example.test', role: 'support' }),
  );
  const order = createOrder({
    id: 'business-order',
    eventId: 'business-event',
    organizationId: 'partner',
    userId: 'buyer',
    contact: { name: 'Synthetic', email: '', phone: '' },
    pricing: {
      lines: [],
      subtotalPaise: 0,
      discountPaise: 0,
      discountedSubtotalPaise: 0,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      gstPaise: 0,
      grandTotalPaise: 0,
      appliedPromoCode: null,
      currency: 'INR',
    },
    now,
  });
  await repositories.orders.save(order);
  const entry = createLedgerEntry({
    id: 'explicit-legacy-entry',
    organizationId: options.foreign ? 'other-partner' : 'partner',
    orderId: order.id,
    eventId: order.eventId,
    entryType: 'host_payout',
    amount: 1000,
    status: 'settled',
    idempotencyKey: 'original-business-entry',
    now,
  });
  await repositories.ledger.createBatch([entry]);
  const journal = createPostedJournal({
    organizationId: entry.organizationId,
    currency: 'INR',
    source: {
      type: 'legacy_backfill',
      id: entry.id,
      orderId: order.id,
      paymentId: null,
      eventId: order.eventId,
    },
    idempotencyKey: 'original-business-journal',
    accountingPolicy: DEFAULT_ACCOUNTING_POLICY,
    postedAt: now,
    lines: [
      {
        account: 'ticket_collection_control',
        side: 'debit',
        amountPaise: options.multiParty ? 2000 : 1000,
        organizationId: entry.organizationId,
        component: null,
        memo: 'Identified original entry',
      },
      {
        account: 'host_payable',
        side: 'credit',
        amountPaise: 1000,
        organizationId: entry.organizationId,
        component: null,
        memo: 'Original partner payable',
      },
      ...(options.multiParty
        ? [
            {
              account: 'venue_payable' as const,
              side: 'credit' as const,
              amountPaise: 1000,
              organizationId: 'other-partner',
              component: null,
              memo: 'Other partner payable',
            },
          ]
        : []),
    ],
  });
  await repositories.financialJournals.postBatch([journal]);
  const dispute = {
    ...createDispute({
      organizationId: 'partner',
      orderId: order.id,
      ledgerEntryId: options.linked === false || options.explicitJournal ? null : entry.id,
      amount: options.amount ?? 1000,
      raisedBy: 'partner-owner',
      reason: 'Original payable entry is disputed',
      now,
    }),
    id: 'business-dispute',
    ...(options.explicitJournal ? { journalId: journal.id } : {}),
  };
  await repositories.disputes.create(dispute);
  return {
    repositories,
    service: new AdminDisputeService(deps, new AdminAuthorityService(deps)),
    dispute,
    journal,
    audit,
  };
}

describe('Admin canonical business-dispute correction', () => {
  it('reverses an explicitly backfilled legacy payable in the canonical journal, not a new legacy refund', async () => {
    const f = await fixture();
    await f.service.resolve(
      'finance-admin',
      f.dispute.id,
      'upheld',
      'Reverse the identified erroneous payable',
    );
    expect(await f.repositories.financialJournals.sumPayableByOrganization('partner')).toBe(0);
    const reversals = await f.repositories.financialJournals.findReversals(f.journal.id);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.source.type).toBe('partner_dispute_reversal');
    expect(
      journalTotals(
        reversals[0] ??
          (() => {
            throw new Error('Missing reversal');
          })(),
      ),
    ).toEqual({ debitPaise: 1000, creditPaise: 1000 });
    expect(
      (await f.repositories.ledger.findByOrder(f.dispute.orderId)).filter(
        (entry) => entry.entryType === 'refund',
      ),
    ).toHaveLength(0);
  });
  it('repairs failed audit append using the original durable operator and one deterministic audit ID', async () => {
    const f = await fixture();
    vi.spyOn(f.audit, 'append').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Exact correction'),
    ).rejects.toThrow('audit unavailable');
    await f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Exact correction');
    await f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Exact correction');
    expect(f.audit.all()).toHaveLength(1);
    expect(f.audit.all()[0]?.adminId).toBe('finance-admin');
    expect(await f.repositories.financialJournals.findReversals(f.journal.id)).toHaveLength(1);
  });
  it('prevents partner resolution from overwriting a claimed Admin correction', async () => {
    const f = await fixture();
    vi.spyOn(f.audit, 'append').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Exact correction'),
    ).rejects.toThrow();
    const claimed = await f.repositories.disputes.findById(f.dispute.id);
    if (!claimed) throw new Error('Missing dispute');
    expect(() =>
      resolveDispute({ ...claimed, status: 'under_review' }, 'Partner override'),
    ).toThrow('Admin resolution');
  });
  it('reverses an explicitly identified erroneous payable debit without treating it as a provider chargeback', async () => {
    const f = await fixture({ explicitJournal: true });
    const debit = createPostedJournal({
      organizationId: 'partner',
      currency: 'INR',
      source: {
        type: 'manual_adjustment',
        id: 'approved-erroneous-deduction',
        orderId: f.dispute.orderId,
        eventId: 'business-event',
        paymentId: null,
      },
      idempotencyKey: 'erroneous-debit',
      accountingPolicy: DEFAULT_ACCOUNTING_POLICY,
      postedAt: new Date(),
      lines: f.journal.lines.map(({ id: _id, currency: _currency, ...line }) => ({
        ...line,
        side: line.side === 'debit' ? 'credit' : 'debit',
      })),
    });
    await f.repositories.financialJournals.postBatch([debit]);
    await f.repositories.disputes.save({
      ...f.dispute,
      journalId: debit.id,
      version: f.dispute.version + 1,
    });
    expect(await f.repositories.financialJournals.sumPayableByOrganization('partner')).toBe(0);
    await f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Reverse erroneous deduction');
    expect(await f.repositories.financialJournals.sumPayableByOrganization('partner')).toBe(1000);
  });
  it('supports explicit canonical journal identity without inferring a legacy link', async () => {
    const f = await fixture({ explicitJournal: true });
    await f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Reverse this exact journal');
    expect(await f.repositories.financialJournals.sumPayableByOrganization('partner')).toBe(0);
  });
  it.each([
    { linked: false },
    { amount: 500 },
    { foreign: true },
    { explicitJournal: true, multiParty: true, amount: 2000 },
  ])('refuses ambiguous, partial or foreign scopes without any correction: %j', async (options) => {
    const f = await fixture(options);
    await expect(
      f.service.resolve(
        'finance-admin',
        f.dispute.id,
        'upheld',
        'Cannot guess a financial correction',
      ),
    ).rejects.toThrow();
    expect(await f.repositories.financialJournals.findReversals(f.journal.id)).toHaveLength(0);
    expect((await f.repositories.disputes.findById(f.dispute.id))?.status).toBe('open');
    expect(
      (await f.repositories.ledger.findByOrder(f.dispute.orderId)).filter(
        (entry) => entry.entryType === 'refund',
      ),
    ).toHaveLength(0);
  });
  it('denies an unlinked claim without posting money or provider chargeback effects', async () => {
    const f = await fixture({ linked: false });
    expect(
      (
        await f.service.resolve(
          'finance-admin',
          f.dispute.id,
          'denied',
          'Evidence does not support the claim',
        )
      ).resolution,
    ).toBe('denied');
    expect(await f.repositories.financialJournals.findReversals(f.journal.id)).toHaveLength(0);
    expect(
      await f.repositories.financialJournals.findBySource('chargeback', f.dispute.id),
    ).toHaveLength(0);
  });
  it('preserves Tier2 authority', async () => {
    const f = await fixture();
    await expect(
      f.service.resolve('support-admin', f.dispute.id, 'upheld', 'Support cannot approve this'),
    ).rejects.toThrow();
    expect(await f.repositories.financialJournals.findReversals(f.journal.id)).toHaveLength(0);
  });
  it('repairs a crash after the canonical reversal without double-correcting', async () => {
    const f = await fixture();
    const save = f.repositories.disputes.save.bind(f.repositories.disputes);
    let failed = false;
    vi.spyOn(f.repositories.disputes, 'save').mockImplementation(async (dispute) => {
      if (dispute.status === 'resolved' && !failed) {
        failed = true;
        throw new Error('resolution persistence interrupted');
      }
      return save(dispute);
    });
    await expect(
      f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Reverse exact original'),
    ).rejects.toThrow('interrupted');
    expect(await f.repositories.financialJournals.sumPayableByOrganization('partner')).toBe(0);
    await f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Reverse exact original');
    expect(await f.repositories.financialJournals.findReversals(f.journal.id)).toHaveLength(1);
    expect((await f.repositories.disputes.findById(f.dispute.id))?.resolution).toBe('upheld');
  });
  it('never posts an upheld correction after a concurrent denied resolution wins', async () => {
    const f = await fixture();
    await Promise.allSettled([
      f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Reverse exact original'),
      f.service.resolve('finance-admin', f.dispute.id, 'denied', 'Do not reverse'),
    ]);
    const resolved = await f.repositories.disputes.findById(f.dispute.id);
    expect(await f.repositories.financialJournals.sumPayableByOrganization('partner')).toBe(
      resolved?.resolution === 'upheld' ? 0 : 1000,
    );
    expect(
      (await f.repositories.ledger.findByOrder(f.dispute.orderId)).filter(
        (entry) => entry.entryType === 'refund',
      ),
    ).toHaveLength(0);
  });
  it('cannot reverse one original journal twice through different dispute IDs', async () => {
    const f = await fixture();
    await f.service.resolve('finance-admin', f.dispute.id, 'upheld', 'Reverse exact original');
    const second = { ...f.dispute, id: 'second-business-dispute' };
    await f.repositories.disputes.create(second);
    await expect(
      f.service.resolve('finance-admin', second.id, 'upheld', 'Second claim on same entry'),
    ).rejects.toThrow();
    expect(await f.repositories.financialJournals.findReversals(f.journal.id)).toHaveLength(1);
  });
});
