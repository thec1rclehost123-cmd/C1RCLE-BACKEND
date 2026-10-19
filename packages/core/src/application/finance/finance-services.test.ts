import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import {
  ForbiddenError,
  IdempotencyConflictError,
  InvalidOperationError,
  NotFoundError,
} from '../../domain/errors.js';
import { cancelEvent, createEvent } from '../../domain/models/event.js';
import { createPostedJournal } from '../../domain/models/financial-journal.js';
import { DEFAULT_JOURNAL_TRANSITION_STATE } from '../../domain/models/journal-transition.js';
import { createLedgerEntry } from '../../domain/models/ledger.js';
import { createPayout } from '../../domain/models/payout.js';
import { MemoryBankAccountRepository } from '../../infrastructure/memory/memory-bank-account-repository.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryJournalTransitionRepository } from '../../infrastructure/memory/memory-journal-transition-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import { MemoryPayoutRepository } from '../../infrastructure/memory/memory-payout-repository.js';
import { MemoryReconciliationRepository } from '../../infrastructure/memory/memory-reconciliation-repository.js';
import {
  MemoryEventRepository,
  MemoryPlatformSettingsRepository,
} from '../../infrastructure/memory/memory-repositories.js';

import { createBankAccountService } from './bank-account-service.js';
import { createFinanceService } from './finance-service.js';
import { FinancialPostingService } from './financial-posting-service.js';
import { createPayoutService } from './payout-service.js';

import type { ActorContext } from '../context.js';

/**
 * ─── Phase 6 finance services over the memory driver ─────────────────────────
 * The route suite (apps/api-gateway/finance-routes.test.ts) covers the happy
 * path over HTTP; these unit tests pin the service rules directly — idempotent
 * ledger replays, balance bucketing, payout draw-down guards (min amount,
 * available balance, ownership) and the account-number-at-rest flow.
 */

const ORG = 'org_1';
const HOST = 'org_host';
const VENUE = 'org_venue';
const PROMOTER = 'org_promoter';
const NOW = new Date('2026-09-07T00:00:00.000Z');

const config = createCoreConfig({
  redis: { url: 'redis://localhost:6379' },
  firestore: { projectId: 'test-project' },
  clock: { now: () => NOW },
});

const actor = (organizationId: string, userId = 'user_1'): ActorContext => ({
  userId,
  organizationId,
  role: 'owner',
  capabilities: [],
});

const transferEvidence = {
  transferReference: 'UTR-TEST-1',
  transferredAt: NOW.toISOString(),
  transferMethod: 'bank_transfer',
  proof: { sha256: 'a'.repeat(64), contentType: 'application/pdf', sizeBytes: 128 },
};

function financeService(ledger: MemoryLedgerRepository) {
  return createFinanceService({
    ledger,
    financialJournals: new MemoryFinancialJournalRepository(),
    journalTransition: new MemoryJournalTransitionRepository(),
    payouts: new MemoryPayoutRepository(),
    events: new MemoryEventRepository(),
    reconciliations: new MemoryReconciliationRepository(),
    config,
  });
}

function seedLedger(repo: MemoryLedgerRepository, organizationId: string) {
  return repo.createBatch([
    createLedgerEntry({
      id: 'led-1',
      organizationId,
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'ticket_revenue',
      amount: 100_000,
      status: 'settled',
      idempotencyKey: 'order_1:ticket_revenue',
      now: NOW,
    }),
    createLedgerEntry({
      id: 'led-2',
      organizationId,
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'host_payout',
      amount: 70_000,
      status: 'pending',
      idempotencyKey: 'order_1:host_payout',
      now: NOW,
    }),
    createLedgerEntry({
      id: 'led-3',
      organizationId,
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'venue_share',
      amount: 10_000,
      status: 'settled',
      idempotencyKey: 'order_1:venue_share',
      now: NOW,
    }),
    createLedgerEntry({
      id: 'led-4',
      organizationId,
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'venue_share',
      amount: 10_000,
      status: 'paid_out',
      idempotencyKey: 'order_1:venue_share:paid',
      now: NOW,
    }),
  ]);
}

describe('createFinanceService', () => {
  it('rejects a cross-tenant recordTicketSale', async () => {
    const service = financeService(new MemoryLedgerRepository());
    await expect(
      service.recordTicketSale(
        {
          organizationId: 'org_other',
          orderId: 'order_x',
          eventId: 'evt_x',
          grossAmount: 100_000,
          hostOrganizationId: HOST,
          venueOrganizationId: VENUE,
          promoterOrganizationId: null,
          platformFeeRate: 0.15,
          venueShareRate: 0.1,
          promoterCommissionRate: null,
        },
        actor('org_1'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('records a full split (host/venue/promoter) and sums to gross', async () => {
    const repo = new MemoryLedgerRepository();
    const service = financeService(repo);
    const entries = await service.recordTicketSale(
      {
        organizationId: ORG,
        orderId: 'order_1',
        eventId: 'evt_1',
        grossAmount: 100_000,
        hostOrganizationId: HOST,
        venueOrganizationId: VENUE,
        promoterOrganizationId: PROMOTER,
        platformFeeRate: 0.15,
        venueShareRate: 0.1,
        promoterCommissionRate: 0.05,
      },
      actor(ORG),
    );

    expect(entries).toHaveLength(5);
    const types = entries.map((e) => e.entryType).sort();
    expect(types).toEqual([
      'host_payout',
      'platform_fee',
      'promoter_commission',
      'ticket_revenue',
      'venue_share',
    ]);
    // Settlement split legs sum to gross (separate from the ticket_revenue leg).
    const splitEntries = entries.filter((e) => e.entryType !== 'ticket_revenue');
    const splitSum = splitEntries.reduce((sum, e) => sum + e.amount, 0);
    expect(splitSum).toBe(100_000);
    // host_payout is derived as the remainder (gross - shares).
    const host = entries.find((e) => e.entryType === 'host_payout');
    expect(host?.amount).toBe(70_000);
  });

  it('is idempotent: a replayed orderId returns the existing entries untouched', async () => {
    const repo = new MemoryLedgerRepository();
    const service = financeService(repo);
    const input = {
      organizationId: ORG,
      orderId: 'order_1',
      eventId: 'evt_1',
      grossAmount: 100_000,
      hostOrganizationId: HOST,
      venueOrganizationId: VENUE,
      promoterOrganizationId: null,
      platformFeeRate: 0.15,
      venueShareRate: 0.1,
      promoterCommissionRate: null,
    };
    const first = await service.recordTicketSale(input, actor(ORG));
    const second = await service.recordTicketSale(input, actor(ORG));
    expect(second).toHaveLength(first.length);
    expect(await repo.findByOrder('order_1')).toHaveLength(first.length);
  });

  it('keeps ledger entry ids within the 64-char opaque-id cap for long order/org ids', async () => {
    const repo = new MemoryLedgerRepository();
    const service = financeService(repo);
    // Razorpay-style long order id + UUID orgs — reproduces the scenario-suite
    // bug where `led-{orderId}-{entryType}-{orgId}` exceeded 64 chars and the
    // frozen wire contract's opaqueIdSchema (max 64) rejected the ledger DTO.
    const input = {
      orderId: 'ORD-pay_2xUeF1PdGqJ7Qj3Z9k8LmW5yvAaCcNnO',
      eventId: 'evt_1',
      grossAmount: 100_000,
      organizationId: 'd0ef124c-a769-4baa-98c7-ed462a81f746',
      hostOrganizationId: 'd0ef124c-a769-4baa-98c7-ed462a81f746',
      venueOrganizationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      promoterOrganizationId: null,
      platformFeeRate: 0.15,
      venueShareRate: 0.1,
      promoterCommissionRate: null,
    };
    const entries = await service.recordTicketSale(input, actor(input.organizationId));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id.length).toBeLessThanOrEqual(64);
      expect(entry.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
      expect(entry.id).not.toContain(':');
    }
    // Replay must produce the same deterministic ids (idempotency preserved).
    const replay = await service.recordTicketSale(input, actor(input.organizationId));
    expect(replay.map((e) => e.id).sort()).toEqual(entries.map((e) => e.id).sort());
  });

  it('getBalances buckets pending/settled/paid_out per the ledger', async () => {
    const repo = new MemoryLedgerRepository();
    await seedLedger(repo, ORG);
    const service = financeService(repo);

    const balances = await service.getBalances(ORG, actor(ORG));
    // host_payout 70k pending; venue_share 10k settled minus 10k paid out.
    expect(balances).toEqual({
      availablePaise: 0,
      pendingPaise: 70_000,
      reservedPaise: 0,
      heldPaise: 0,
      paidPaise: 0,
      lifetimePaise: 90_000,
      holds: {
        reservePaise: 0,
        cancellationPaise: 0,
        chargebackPaise: 0,
        reconciliationPaise: 0,
      },
      readModel: 'legacy_ledger_v1',
    });
  });

  it('uses only journal payables after cutover and applies reserves and reconciliation holds', async () => {
    const ledger = new MemoryLedgerRepository();
    await ledger.createBatch([
      createLedgerEntry({
        id: 'legacy-only',
        organizationId: ORG,
        orderId: 'legacy-order',
        eventId: 'legacy-event',
        entryType: 'host_payout',
        amount: 999_000,
        status: 'settled',
        idempotencyKey: 'legacy-only',
        now: NOW,
      }),
    ]);
    const financialJournals = new MemoryFinancialJournalRepository();
    const posting = new FinancialPostingService(financialJournals);
    const policy = {
      version: 'test-v1',
      capturedAt: NOW.toISOString(),
      settlementDelayDays: 0,
      reserveBasisPoints: 1_000,
      requiresEventCompletion: false,
      holdsOnCancellation: true,
      holdsOnDispute: true,
      holdsOnUnresolvedReconciliation: true,
    };
    await posting.postTicketSale({
      organizationId: ORG,
      orderId: 'journal-order',
      eventId: 'event_1',
      paymentId: 'pay_1',
      sourceType: 'online_payment_capture',
      providerConfirmed: true,
      currency: 'INR',
      ticketFaceValuePaise: 100_000,
      discountPaise: 0,
      discountFundingOwner: null,
      netTicketRevenuePaise: 100_000,
      gstPaise: 0,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      allocation: {
        platformPaise: 20_000,
        hostOrganizationId: ORG,
        hostPaise: 80_000,
        venueOrganizationId: null,
        venuePaise: 0,
        promoterOrganizationId: null,
        promoterPaise: 0,
      },
      policy,
      postedAt: NOW,
    });
    const payouts = new MemoryPayoutRepository();
    const payout = createPayout({
      organizationId: ORG,
      bankAccountId: 'bank_1',
      amount: 30_000,
      requestedBy: 'user_1',
      now: NOW,
    });
    await payouts.create(payout);
    await posting.postPayoutReservation({
      organizationId: ORG,
      payoutId: payout.id,
      amountPaise: payout.amount,
      policy,
      postedAt: NOW,
    });
    const journalTransition = new MemoryJournalTransitionRepository();
    journalTransition.state = {
      ...DEFAULT_JOURNAL_TRANSITION_STATE,
      phase: 'journal_reads',
      readModel: 'financial_journal_v2',
    };
    const reconciliations = new MemoryReconciliationRepository();
    reconciliations.discrepancies.set('rec-1', {
      id: 'rec-1',
      runId: 'run-1',
      kind: 'amount_mismatch',
      state: 'finance_review',
      organizationId: ORG,
      orderId: 'journal-order',
      paymentId: 'pay_1',
      payoutId: null,
      amountPaise: 20_000,
      currency: 'INR',
      evidence: {},
      repair: null,
      resolutionReason: null,
      resolvedBy: null,
      resolvedAt: null,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const service = createFinanceService({
      ledger,
      financialJournals,
      journalTransition,
      payouts,
      events: new MemoryEventRepository(),
      reconciliations,
      config,
    });

    expect(await service.getBalances(ORG, actor(ORG))).toEqual({
      availablePaise: 22_000,
      pendingPaise: 0,
      reservedPaise: 30_000,
      heldPaise: 28_000,
      paidPaise: 0,
      lifetimePaise: 80_000,
      holds: {
        reservePaise: 8_000,
        cancellationPaise: 0,
        chargebackPaise: 0,
        reconciliationPaise: 20_000,
      },
      readModel: 'financial_journal_v2',
    });
  });

  it('getBalances reflects settled inflow minus paid out when nothing is pending', async () => {
    const repo = new MemoryLedgerRepository();
    await repo.createBatch([
      createLedgerEntry({
        id: 'led-a',
        organizationId: ORG,
        orderId: 'order_a',
        eventId: 'evt_a',
        entryType: 'host_payout',
        amount: 50_000,
        status: 'settled',
        idempotencyKey: 'order_a:host_payout',
        now: NOW,
      }),
      createLedgerEntry({
        id: 'led-b',
        organizationId: ORG,
        orderId: 'order_a',
        eventId: 'evt_a',
        entryType: 'host_payout',
        amount: 20_000,
        status: 'paid_out',
        idempotencyKey: 'order_a:host_payout:paid',
        now: NOW,
      }),
    ]);
    const service = financeService(repo);
    const balances = await service.getBalances(ORG, actor(ORG));
    expect(balances.availablePaise).toBe(30_000);
    expect(balances.pendingPaise).toBe(0);
    expect(balances.lifetimePaise).toBe(70_000);
  });

  it('holds a cancelled event payable when the posting policy requires it', async () => {
    const financialJournals = new MemoryFinancialJournalRepository();
    const policy = {
      version: 'test-cancellation-v1',
      capturedAt: NOW.toISOString(),
      settlementDelayDays: 0,
      reserveBasisPoints: 0,
      requiresEventCompletion: false,
      holdsOnCancellation: true,
      holdsOnDispute: true,
      holdsOnUnresolvedReconciliation: true,
    };
    await financialJournals.postBatch([
      createPostedJournal({
        organizationId: ORG,
        currency: 'INR',
        source: {
          type: 'online_payment_capture',
          id: 'cancelled-order',
          orderId: 'cancelled-order',
          paymentId: 'pay-cancelled',
          eventId: 'event-cancelled',
        },
        idempotencyKey: 'test:cancelled-order:allocation',
        accountingPolicy: policy,
        postedAt: NOW,
        lines: [
          {
            account: 'ticket_collection_control',
            side: 'debit',
            amountPaise: 80_000,
            organizationId: ORG,
            component: 'netTicketRevenuePaise',
            memo: 'allocate',
          },
          {
            account: 'host_payable',
            side: 'credit',
            amountPaise: 80_000,
            organizationId: ORG,
            component: 'hostAllocationPaise',
            memo: 'host payable',
          },
        ],
      }),
    ]);
    const events = new MemoryEventRepository();
    const event = createEvent({
      id: 'event-cancelled',
      organizationId: ORG,
      venueId: 'venue-1',
      title: 'Cancelled event',
      startAt: NOW.toISOString(),
      now: NOW,
    });
    events.events.set(event.id, cancelEvent(event, 'test cancellation', NOW));
    const journalTransition = new MemoryJournalTransitionRepository();
    journalTransition.state = {
      ...DEFAULT_JOURNAL_TRANSITION_STATE,
      phase: 'journal_reads',
      readModel: 'financial_journal_v2',
    };
    const service = createFinanceService({
      ledger: new MemoryLedgerRepository(),
      financialJournals,
      journalTransition,
      payouts: new MemoryPayoutRepository(),
      events,
      reconciliations: new MemoryReconciliationRepository(),
      config,
    });

    const balance = await service.getBalances(ORG, actor(ORG));
    expect(balance.availablePaise).toBe(0);
    expect(balance.heldPaise).toBe(80_000);
    expect(balance.holds.cancellationPaise).toBe(80_000);
  });

  it('classifies only the remaining payable after a refund reversal', async () => {
    const financialJournals = new MemoryFinancialJournalRepository();
    const policy = {
      version: 'test-net-hold-v1',
      capturedAt: NOW.toISOString(),
      settlementDelayDays: 0,
      reserveBasisPoints: 0,
      requiresEventCompletion: false,
      holdsOnCancellation: true,
      holdsOnDispute: true,
      holdsOnUnresolvedReconciliation: true,
    };
    await financialJournals.postBatch([
      createPostedJournal({
        organizationId: ORG,
        currency: 'INR',
        source: {
          type: 'online_payment_capture',
          id: 'partially-refunded-order',
          orderId: 'partially-refunded-order',
          paymentId: 'pay-partial',
          eventId: 'event-partial',
        },
        idempotencyKey: 'test:partial:allocation',
        accountingPolicy: policy,
        postedAt: NOW,
        lines: [
          {
            account: 'ticket_collection_control',
            side: 'debit',
            amountPaise: 80_000,
            organizationId: ORG,
            component: 'netTicketRevenuePaise',
            memo: 'allocate',
          },
          {
            account: 'host_payable',
            side: 'credit',
            amountPaise: 80_000,
            organizationId: ORG,
            component: 'hostAllocationPaise',
            memo: 'host payable',
          },
        ],
      }),
      createPostedJournal({
        organizationId: ORG,
        currency: 'INR',
        source: {
          type: 'refund',
          id: 'refund-partial',
          orderId: 'partially-refunded-order',
          paymentId: 'pay-partial',
          eventId: 'event-partial',
        },
        idempotencyKey: 'test:partial:refund-reversal',
        accountingPolicy: policy,
        postedAt: NOW,
        lines: [
          {
            account: 'host_payable',
            side: 'debit',
            amountPaise: 30_000,
            organizationId: ORG,
            component: 'refundPaise',
            memo: 'partial refund payable reversal',
          },
          {
            account: 'ticket_collection_control',
            side: 'credit',
            amountPaise: 30_000,
            organizationId: ORG,
            component: 'refundPaise',
            memo: 'partial refund control',
          },
        ],
      }),
    ]);
    const events = new MemoryEventRepository();
    const event = createEvent({
      id: 'event-partial',
      organizationId: ORG,
      venueId: 'venue-1',
      title: 'Partially refunded cancelled event',
      startAt: NOW.toISOString(),
      now: NOW,
    });
    events.events.set(event.id, cancelEvent(event, 'test cancellation', NOW));
    const journalTransition = new MemoryJournalTransitionRepository();
    journalTransition.state = {
      ...DEFAULT_JOURNAL_TRANSITION_STATE,
      phase: 'journal_reads',
      readModel: 'financial_journal_v2',
    };
    const service = createFinanceService({
      ledger: new MemoryLedgerRepository(),
      financialJournals,
      journalTransition,
      payouts: new MemoryPayoutRepository(),
      events,
      reconciliations: new MemoryReconciliationRepository(),
      config,
    });

    const balance = await service.getBalances(ORG, actor(ORG));
    expect(balance.availablePaise).toBe(0);
    expect(balance.heldPaise).toBe(50_000);
    expect(balance.holds.cancellationPaise).toBe(50_000);
  });

  it('listLedgerEntries pages in reverse-chronological order', async () => {
    const repo = new MemoryLedgerRepository();
    await seedLedger(repo, ORG);
    const service = financeService(repo);

    const page1 = await service.listLedgerEntries(ORG, actor(ORG), { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(4);
    const page2 = await service.listLedgerEntries(ORG, actor(ORG), {
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((e) => e.id);
    expect(ids).toEqual(['led-1', 'led-2', 'led-3', 'led-4']);
  });

  it('listLedgerEntries rejects cross-tenant access', async () => {
    const service = financeService(new MemoryLedgerRepository());
    await expect(
      service.listLedgerEntries('org_other', actor(ORG), { limit: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('createPayoutService', () => {
  function makeDeps() {
    const bankAccounts = new MemoryBankAccountRepository();
    const ledger = new MemoryLedgerRepository();
    const financialJournals = new MemoryFinancialJournalRepository();
    const payouts = new MemoryPayoutRepository(financialJournals);
    const platformSettings = new MemoryPlatformSettingsRepository();
    const journalTransition = new MemoryJournalTransitionRepository();
    const events = new MemoryEventRepository();
    const reconciliations = new MemoryReconciliationRepository();
    const service = createPayoutService({
      payouts,
      bankAccounts,
      ledger,
      financialJournals,
      journalTransition,
      events,
      reconciliations,
      platformSettings,
      config,
    });
    return { payouts, bankAccounts, ledger, financialJournals, service };
  }

  async function seedDefaults(deps: ReturnType<typeof makeDeps>) {
    const { bankAccounts, ledger } = deps;
    await ledger.createBatch([
      createLedgerEntry({
        id: 'led-avail',
        organizationId: ORG,
        orderId: 'order_avail',
        eventId: 'evt_1',
        entryType: 'host_payout',
        amount: 100_000,
        status: 'settled',
        idempotencyKey: 'order_avail:host_payout',
        now: NOW,
      }),
    ]);
    await bankAccounts.create(
      createBankAccountFixture('bank_1', ORG, true, '••1234', 'envelope-1'),
    );
  }

  function createBankAccountFixture(
    id: string,
    organizationId: string,
    isDefault: boolean,
    last4 = '1234',
    encryptedAccountNumber = 'iv:tag:cipher',
  ) {
    return {
      id,
      organizationId,
      bankName: 'HDFC Bank',
      accountHolder: 'Test Org',
      last4,
      encryptedAccountNumber,
      ifscCode: 'HDFC0001234',
      isDefault,
      verified: false,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
  }

  it('requestPayout draws down the default account', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000, idempotencyKey: 'payout-default' },
      actor(ORG),
    );
    expect(payout.status).toBe('requested');
    expect(payout.bankAccountId).toBe('bank_1');
    expect(payout.requestedBy).toBe('user_1');
  });

  it('replays the same payout intent once and rejects changed facts', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const input = {
      organizationId: ORG,
      amount: 50_000,
      idempotencyKey: 'payout-replay',
    };

    const first = await deps.service.requestPayout(input, actor(ORG));
    const replay = await deps.service.requestPayout(input, actor(ORG));

    expect(replay).toEqual(first);
    expect([...deps.payouts.payouts.values()]).toEqual([first]);
    expect(await deps.financialJournals.findBySource('payout_reservation', first.id)).toHaveLength(
      1,
    );
    await expect(
      deps.service.requestPayout({ ...input, amount: 60_000 }, actor(ORG)),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('requestPayout honors an explicit bankAccountId', async () => {
    const deps = makeDeps();
    const { bankAccounts, ledger } = deps;
    await ledger.createBatch([
      createLedgerEntry({
        id: 'led-avail',
        organizationId: ORG,
        orderId: 'order_avail',
        eventId: 'evt_1',
        entryType: 'host_payout',
        amount: 100_000,
        status: 'settled',
        idempotencyKey: 'order_avail:host_payout',
        now: NOW,
      }),
    ]);
    await bankAccounts.create(createBankAccountFixture('bank_a', ORG, true));
    await bankAccounts.create(createBankAccountFixture('bank_b', ORG, false));
    const payout = await deps.service.requestPayout(
      {
        organizationId: ORG,
        amount: 25_000,
        bankAccountId: 'bank_b',
        idempotencyKey: 'payout-bank-b',
      },
      actor(ORG),
    );
    expect(payout.bankAccountId).toBe('bank_b');
  });

  it('requestPayout throws NotFoundError when the bank account is missing', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    await expect(
      deps.service.requestPayout(
        {
          organizationId: ORG,
          amount: 50_000,
          bankAccountId: 'bank_nope',
          idempotencyKey: 'payout-missing-bank',
        },
        actor(ORG),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('requestPayout throws ForbiddenError for an account from another org', async () => {
    const deps = makeDeps();
    const { bankAccounts, ledger } = deps;
    await ledger.createBatch([
      createLedgerEntry({
        id: 'led-avail',
        organizationId: ORG,
        orderId: 'order_avail',
        eventId: 'evt_1',
        entryType: 'host_payout',
        amount: 100_000,
        status: 'settled',
        idempotencyKey: 'order_avail:host_payout',
        now: NOW,
      }),
    ]);
    await bankAccounts.create(createBankAccountFixture('bank_other', 'org_other', true));
    await expect(
      deps.service.requestPayout(
        {
          organizationId: ORG,
          amount: 50_000,
          bankAccountId: 'bank_other',
          idempotencyKey: 'payout-other-bank',
        },
        actor(ORG),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('requestPayout rejects amounts above the available balance', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    await expect(
      deps.service.requestPayout(
        { organizationId: ORG, amount: 200_000, idempotencyKey: 'payout-too-large' },
        actor(ORG),
      ),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('atomically prevents concurrent payout reservations from overdrawing', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const attempts = await Promise.allSettled([
      deps.service.requestPayout(
        { organizationId: ORG, amount: 75_000, idempotencyKey: 'payout-race-a' },
        actor(ORG),
      ),
      deps.service.requestPayout(
        { organizationId: ORG, amount: 75_000, idempotencyKey: 'payout-race-b' },
        actor(ORG),
      ),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('beginProcessing → complete moves a payout to paid with a processedAt', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000, idempotencyKey: 'payout-complete' },
      actor(ORG),
    );
    const processing = await deps.service.beginProcessingPayout(payout.id, actor(ORG));
    expect(processing.status).toBe('processing');
    expect(processing.version).toBe(2);
    const paid = await deps.service.completePayout(
      payout.id,
      transferEvidence,
      actor(ORG, 'finance_approver'),
    );
    expect(paid.status).toBe('paid');
    expect(paid.processedAt).toBe(NOW.toISOString());
    expect(paid.version).toBe(3);
  });

  it('failPayout marks a requested payout failed with a reason', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000, idempotencyKey: 'payout-fail' },
      actor(ORG),
    );
    const failed = await deps.service.failPayout(payout.id, 'insufficient funds', actor(ORG));
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('insufficient funds');
    expect(failed.processedAt).toBe(NOW.toISOString());
  });

  it('does not reverse a reservation when failing an ineligible payout', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000, idempotencyKey: 'payout-invalid-fail' },
      actor(ORG),
    );
    await deps.service.beginProcessingPayout(payout.id, actor(ORG));
    await deps.service.completePayout(payout.id, transferEvidence, actor(ORG, 'finance_approver'));

    await expect(deps.service.failPayout(payout.id, 'too late', actor(ORG))).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
    expect(await deps.financialJournals.findBySource('payout_failure_reversal', payout.id)).toEqual(
      [],
    );
  });

  it('beginProcessingPayout throws NotFoundError for an unknown payout', async () => {
    const deps = makeDeps();
    await expect(
      deps.service.beginProcessingPayout('payout_nope', actor(ORG)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('completePayout rejects cross-tenant access', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000, idempotencyKey: 'payout-cross-tenant' },
      actor(ORG),
    );
    await expect(
      deps.service.completePayout(payout.id, transferEvidence, actor('org_other')),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('listPayouts returns only this org payouts', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const { payouts } = deps;
    for (const [idx, amount] of [10_000, 20_000, 30_000].entries()) {
      await payouts.create({
        id: `payout-${ORG}-${idx}`,
        organizationId: ORG,
        bankAccountId: 'bank_1',
        amount,
        status: 'requested',
        failureReason: null,
        requestedBy: 'user_1',
        processedAt: null,
        transferReference: null,
        transferredAt: null,
        transferMethod: null,
        transferProof: null,
        approvedBy: null,
        previousStatus: null,
        version: 1,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
    }
    await payouts.create({
      id: `payout-org_other-0`,
      organizationId: 'org_other',
      bankAccountId: 'bank_x',
      amount: 10_000,
      status: 'requested',
      failureReason: null,
      requestedBy: 'user_1',
      processedAt: null,
      transferReference: null,
      transferredAt: null,
      transferMethod: null,
      transferProof: null,
      approvedBy: null,
      previousStatus: null,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const page = await deps.service.listPayouts(ORG, actor(ORG), { limit: 10 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(3);
  });

  it('getPayout returns null for a missing payout and the payout when found', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    expect(await deps.service.getPayout('payout_nope', actor(ORG))).toBeNull();
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000, idempotencyKey: 'payout-get' },
      actor(ORG),
    );
    expect((await deps.service.getPayout(payout.id, actor(ORG)))?.id).toBe(payout.id);
  });
});

describe('createBankAccountService', () => {
  function makeDeps() {
    const bankAccounts = new MemoryBankAccountRepository();
    const service = createBankAccountService({ bankAccounts, config });
    return { bankAccounts, service };
  }

  it('adds a bank account as default when it is the first, with masked + encrypted number', async () => {
    const { service, bankAccounts } = makeDeps();
    const account = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC Bank',
        accountHolder: 'Test Org',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    expect(account.isDefault).toBe(true);
    expect(account.last4).toBe('7890');
    expect(account.encryptedAccountNumber).toContain(':');
    expect(account.encryptedAccountNumber).not.toBe('00001234567890');
    expect(bankAccounts.accounts.size).toBe(1);
  });

  it('adds subsequent accounts as non-default', async () => {
    const { service } = makeDeps();
    await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    const second = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'ICICI',
        accountHolder: 'B',
        accountNumber: '00009999888877',
        ifscCode: 'ICIC0001234',
      },
      actor(ORG),
    );
    expect(second.isDefault).toBe(false);
    expect(second.last4).toBe('8877');
  });

  it('rejects cross-tenant account creation', async () => {
    const { service } = makeDeps();
    await expect(
      service.addBankAccount(
        {
          organizationId: 'org_other',
          bankName: 'HDFC',
          accountHolder: 'A',
          accountNumber: '00001234567890',
          ifscCode: 'HDFC0001234',
        },
        actor(ORG),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('setDefaultBankAccount unsets the previous default', async () => {
    const { service, bankAccounts } = makeDeps();
    const first = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    const second = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'ICICI',
        accountHolder: 'B',
        accountNumber: '00009999888877',
        ifscCode: 'ICIC0001234',
      },
      actor(ORG),
    );
    const madeDefault = await service.setDefaultBankAccount(second.id, actor(ORG));
    expect(madeDefault.isDefault).toBe(true);
    const after = await bankAccounts.findById(first.id);
    expect(after?.isDefault).toBe(false);
  });

  it('setDefaultBankAccount throws NotFoundError for a missing account', async () => {
    const { service } = makeDeps();
    await expect(service.setDefaultBankAccount('bank_nope', actor(ORG))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('removeAccount removes a non-default account and rejects a default', async () => {
    const { service, bankAccounts } = makeDeps();
    const defaultAccount = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    const second = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'ICICI',
        accountHolder: 'B',
        accountNumber: '00009999888877',
        ifscCode: 'ICIC0001234',
      },
      actor(ORG),
    );
    await expect(service.removeAccount(defaultAccount.id, actor(ORG))).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
    await service.removeAccount(second.id, actor(ORG));
    expect(await bankAccounts.findById(second.id)).toBeNull();
  });

  it('removeAccount rejects cross-tenant access', async () => {
    const { service, bankAccounts } = makeDeps();
    const account = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    await expect(service.removeAccount(account.id, actor('org_other'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(bankAccounts.accounts.size).toBe(1);
  });

  it('getFullAccountNumber round-trips the decrypted number', async () => {
    const { service } = makeDeps();
    const account = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    expect(await service.getFullAccountNumber(account.id, actor(ORG))).toBe('00001234567890');
  });

  describe('encryption key rotation', () => {
    const rotatedConfig = createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
      clock: { now: () => NOW },
      bankEncryptionSecret: 'a-real-secret-that-is-not-the-published-default-0123456789',
      bankEncryptionSalt: 'a-real-salt',
    });
    const newAccount = {
      organizationId: ORG,
      bankName: 'HDFC',
      accountHolder: 'A',
      accountNumber: '00001234567890',
      ifscCode: 'HDFC0001234',
    };

    it('reads records sealed under the legacy default key after the key is configured', async () => {
      const bankAccounts = new MemoryBankAccountRepository();
      // Written by a deployment that never wired ENCRYPTION_KEY (legacy defaults).
      const legacy = createBankAccountService({ bankAccounts, config });
      const account = await legacy.addBankAccount(newAccount, actor(ORG));

      const rotated = createBankAccountService({ bankAccounts, config: rotatedConfig });
      expect(await rotated.getFullAccountNumber(account.id, actor(ORG))).toBe('00001234567890');
    });

    it('seals new records with the configured key, not the legacy default', async () => {
      const bankAccounts = new MemoryBankAccountRepository();
      const rotated = createBankAccountService({ bankAccounts, config: rotatedConfig });
      const account = await rotated.addBankAccount(newAccount, actor(ORG));

      // A deployment still on the legacy defaults must NOT be able to open it.
      const legacy = createBankAccountService({ bankAccounts, config });
      await expect(legacy.getFullAccountNumber(account.id, actor(ORG))).rejects.toThrow();
      expect(await rotated.getFullAccountNumber(account.id, actor(ORG))).toBe('00001234567890');
    });

    it('fails when a record opens under neither the configured nor the legacy key', async () => {
      const bankAccounts = new MemoryBankAccountRepository();
      const otherConfig = createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'test-project' },
        clock: { now: () => NOW },
        bankEncryptionSecret: 'some-other-secret-entirely-0123456789-abcdefghij',
      });
      const other = createBankAccountService({ bankAccounts, config: otherConfig });
      const account = await other.addBankAccount(newAccount, actor(ORG));

      const rotated = createBankAccountService({ bankAccounts, config: rotatedConfig });
      await expect(rotated.getFullAccountNumber(account.id, actor(ORG))).rejects.toThrow();
    });
  });

  it('getFullAccountNumber throws InvalidOperationError when the field is unset', async () => {
    const { bankAccounts } = makeDeps();
    const deps = { bankAccounts, config };
    const service = createBankAccountService(deps);
    const account = {
      id: 'bank_plain',
      organizationId: ORG,
      bankName: 'HDFC',
      accountHolder: 'A',
      last4: '7890',
      encryptedAccountNumber: '',
      ifscCode: 'HDFC0001234',
      isDefault: true,
      verified: false,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    await bankAccounts.create(account);
    await expect(service.getFullAccountNumber(account.id, actor(ORG))).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
  });
});
