import { describe, expect, it } from 'vitest';

import { createLedgerEntry } from '../../domain/models/ledger.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryJournalTransitionRepository } from '../../infrastructure/memory/memory-journal-transition-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import { MemoryPayoutRepository } from '../../infrastructure/memory/memory-payout-repository.js';

import { JournalTransitionService } from './journal-transition-service.js';

import type { ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');

function build() {
  const ledger = new MemoryLedgerRepository();
  const financialJournals = new MemoryFinancialJournalRepository();
  const payouts = new MemoryPayoutRepository(financialJournals);
  const journalTransition = new MemoryJournalTransitionRepository();
  const organizations = [{ id: 'org_host' }, { id: 'org_venue' }];
  const deps = {
    config: { clock: { now: () => NOW } },
    repositories: {
      ledger,
      financialJournals,
      journalTransition,
      payouts,
      organizations: {
        listAll: async ({ cursor, limit }: { cursor?: string | null; limit: number }) => {
          const start = cursor ? organizations.findIndex((item) => item.id === cursor) + 1 : 0;
          const items = organizations.slice(start, start + limit);
          return {
            items,
            total: organizations.length,
            nextCursor:
              start + items.length < organizations.length ? (items.at(-1)?.id ?? null) : null,
          };
        },
      },
    },
  } as unknown as ServiceDeps;
  return {
    service: new JournalTransitionService(deps),
    ledger,
    financialJournals,
    journalTransition,
    payouts,
  };
}

async function seedLegacy(ledger: MemoryLedgerRepository) {
  await ledger.createBatch([
    createLedgerEntry({
      id: 'led_host',
      organizationId: 'org_host',
      orderId: 'order_1',
      eventId: 'event_1',
      entryType: 'host_payout',
      amount: 8_000,
      status: 'settled',
      idempotencyKey: 'order_1:host_payout:org_host',
      now: NOW,
    }),
    createLedgerEntry({
      id: 'led_venue',
      organizationId: 'org_venue',
      orderId: 'order_1',
      eventId: 'event_1',
      entryType: 'venue_share',
      amount: 2_000,
      status: 'pending',
      idempotencyKey: 'order_1:venue_share:org_venue',
      now: NOW,
    }),
  ]);
}

describe('JournalTransitionService', () => {
  it('previews without writing, backfills deterministically, compares, cuts over, and rolls back', async () => {
    const { service, ledger, financialJournals, journalTransition } = build();
    await seedLegacy(ledger);

    const preview = await service.previewNextBatch();
    expect(preview.journals).toHaveLength(2);
    expect(preview.projectionRepairs).toEqual([]);
    expect(await financialJournals.sumPayableByOrganization('org_host')).toBe(0);
    expect((await journalTransition.get()).phase).toBe('legacy_reads');

    const result = await service.backfillNextBatch();
    expect(result.posted).toHaveLength(2);
    expect(await financialJournals.sumPayableByOrganization('org_host')).toBe(8_000);
    expect(await financialJournals.sumPayableByOrganization('org_venue')).toBe(2_000);

    const compared = await service.compare();
    expect(compared.discrepancies).toEqual([]);
    expect(compared.readModel).toBe('legacy_ledger_v1');

    const cutover = await service.cutover();
    expect(cutover.readModel).toBe('financial_journal_v2');
    const rolledBack = await service.rollback();
    expect(rolledBack.readModel).toBe('legacy_ledger_v1');
  });

  it('reports discrepancies and blocks cutover', async () => {
    const { service, ledger, financialJournals } = build();
    await seedLegacy(ledger);
    await service.backfillNextBatch();
    const venueJournal = [...financialJournals.journals.values()].find(
      (journal) => journal.organizationId === 'org_venue',
    );
    if (!venueJournal) throw new Error('expected venue journal fixture');
    financialJournals.journals.delete(venueJournal.id);

    const compared = await service.compare();
    expect(compared.discrepancies).toHaveLength(1);
    await expect(service.cutover()).rejects.toThrow('blocked by comparison discrepancies');
  });

  it('does not duplicate an order payable already represented by a live journal', async () => {
    const { service, ledger, financialJournals } = build();
    await seedLegacy(ledger);
    const preview = await service.previewNextBatch();
    const host = preview.journals.find((journal) => journal.organizationId === 'org_host');
    if (!host) throw new Error('expected host journal fixture');
    await financialJournals.postBatch([host]);

    const secondPreview = await service.previewNextBatch();
    expect(secondPreview.journals.map((journal) => journal.organizationId)).toEqual(['org_venue']);
    expect(secondPreview.projectionRepairs).toEqual([host]);
  });

  it('never recreates a paid-out legacy liability during backfill', async () => {
    const { service, ledger, financialJournals } = build();
    await ledger.createBatch([
      createLedgerEntry({
        id: 'led_paid_out',
        organizationId: 'org_host',
        orderId: 'order_paid_out',
        eventId: 'event_1',
        entryType: 'host_payout',
        amount: 8_000,
        status: 'paid_out',
        idempotencyKey: 'order_paid_out:host_payout:org_host',
        now: NOW,
      }),
    ]);

    expect((await service.previewNextBatch()).journals).toEqual([]);
    await service.backfillNextBatch();
    expect(await financialJournals.sumPayableByOrganization('org_host')).toBe(0);
    expect((await service.compare()).discrepancies).toEqual([]);
  });

  it('backfills historical payout reservations and completion evidence before cutover', async () => {
    const { service, ledger, financialJournals, payouts } = build();
    await ledger.createBatch([
      createLedgerEntry({
        id: 'led_paid_history',
        organizationId: 'org_host',
        orderId: 'order_paid_history',
        eventId: 'event_1',
        entryType: 'host_payout',
        amount: 80_000,
        status: 'settled',
        idempotencyKey: 'order_paid_history:host_payout:org_host',
        now: NOW,
      }),
    ]);
    payouts.payouts.set('payout_history', {
      id: 'payout_history',
      organizationId: 'org_host',
      bankAccountId: 'bank_1',
      amount: 80_000,
      status: 'paid',
      failureReason: null,
      requestedBy: 'partner_1',
      processedAt: NOW.toISOString(),
      transferReference: 'UTR-HISTORY',
      transferredAt: NOW.toISOString(),
      transferMethod: 'bank_transfer',
      transferProof: {
        sha256: 'a'.repeat(64),
        contentType: 'application/pdf',
        sizeBytes: 128,
      },
      approvedBy: 'finance_1',
      previousStatus: null,
      version: 3,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    await service.backfillNextBatch();

    expect(await financialJournals.sumPayableByOrganization('org_host')).toBe(0);
    expect(
      await financialJournals.findBySource('payout_reservation', 'payout_history'),
    ).toHaveLength(1);
    expect(
      await financialJournals.findBySource('payout_completion', 'payout_history'),
    ).toHaveLength(1);
    expect((await service.compare()).discrepancies).toEqual([]);
  });
});
