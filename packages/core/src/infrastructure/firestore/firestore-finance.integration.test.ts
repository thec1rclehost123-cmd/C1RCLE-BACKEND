import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { IdempotencyConflictError } from '../../domain/errors.js';
import {
  createPostedJournal,
  DEFAULT_ACCOUNTING_POLICY,
} from '../../domain/models/financial-journal.js';

import { FirestoreFinancialJournalRepository } from './firestore-financial-journal-repository.js';
import { FirestorePayoutRepository } from './firestore-payout-repository.js';

import type { Payout } from '../../domain/models/payout.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('finance repositories (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  it('posts a journal once, replays it exactly, and projects payable lines', async () => {
    const run = randomUUID();
    const organizationId = `org_${run}`;
    const repository = new FirestoreFinancialJournalRepository(db);
    const journal = createPostedJournal({
      organizationId,
      currency: 'INR',
      source: {
        type: 'manual_adjustment',
        id: `adjustment_${run}`,
        orderId: null,
        paymentId: null,
        eventId: null,
      },
      idempotencyKey: `test:finance:${run}`,
      accountingPolicy: DEFAULT_ACCOUNTING_POLICY,
      postedAt: new Date('2026-10-16T00:00:00.000Z'),
      lines: [
        {
          account: 'manual_adjustment_control',
          side: 'debit',
          amountPaise: 25_000,
          organizationId,
          component: null,
          memo: 'Emulator adjustment control',
        },
        {
          account: 'partner_payable',
          side: 'credit',
          amountPaise: 25_000,
          organizationId,
          component: null,
          memo: 'Emulator partner payable',
        },
      ],
    });

    const [first] = await repository.postBatch([journal]);
    const [replay] = await repository.postBatch([journal]);

    expect(replay).toEqual(first);
    expect(await repository.sumPayableByOrganization(organizationId)).toBe(25_000);
    expect(await repository.listPayableLinesByOrganization(organizationId)).toEqual([
      expect.objectContaining({
        journalId: journal.id,
        account: 'partner_payable',
        side: 'credit',
        amountPaise: 25_000,
      }),
    ]);

    const changed = createPostedJournal({
      organizationId,
      currency: 'INR',
      source: journal.source,
      idempotencyKey: journal.idempotencyKey,
      accountingPolicy: journal.accountingPolicy,
      lines: [
        {
          account: 'manual_adjustment_control',
          side: 'debit',
          amountPaise: 30_000,
          organizationId,
          component: null,
          memo: 'Changed adjustment control',
        },
        {
          account: 'partner_payable',
          side: 'credit',
          amountPaise: 30_000,
          organizationId,
          component: null,
          memo: 'Changed partner payable',
        },
      ],
    });
    await expect(repository.postBatch([changed])).rejects.toBeInstanceOf(IdempotencyConflictError);
  }, 120_000);

  it('serializes concurrent payout reservations against one payable limit', async () => {
    const run = randomUUID();
    const organizationId = `org_${run}`;
    const repository = new FirestorePayoutRepository(db);
    const now = '2026-10-16T00:00:00.000Z';
    const payout = (suffix: string): Payout => ({
      id: `payout_${run}_${suffix}`,
      organizationId,
      bankAccountId: `bank_${run}`,
      amount: 60_000,
      status: 'requested',
      failureReason: null,
      requestedBy: `requester_${suffix}`,
      processedAt: null,
      transferReference: null,
      transferredAt: null,
      transferMethod: null,
      transferProof: null,
      approvedBy: null,
      previousStatus: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const reservation = (item: Payout) =>
      createPostedJournal({
        organizationId,
        currency: 'INR',
        source: {
          type: 'payout_reservation',
          id: item.id,
          orderId: null,
          paymentId: null,
          eventId: null,
        },
        idempotencyKey: `m2:payout:${item.id}:reservation`,
        accountingPolicy: DEFAULT_ACCOUNTING_POLICY,
        postedAt: new Date(now),
        lines: [
          {
            account: 'partner_payable',
            side: 'debit',
            amountPaise: item.amount,
            organizationId,
            component: 'payoutPaise',
            memo: 'Reserve payout',
          },
          {
            account: 'payout_clearing',
            side: 'credit',
            amountPaise: item.amount,
            organizationId,
            component: 'payoutPaise',
            memo: 'Await transfer',
          },
        ],
      });
    const first = payout('a');
    const second = payout('b');

    const results = await Promise.allSettled([
      repository.createWithinLimit(first, 100_000, reservation(first)),
      repository.createWithinLimit(second, 100_000, reservation(second)),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await repository.sumRequestedOrProcessingByOrganization(organizationId)).toBe(60_000);
    expect(
      await new FirestoreFinancialJournalRepository(db).sumPayableByOrganization(organizationId),
    ).toBe(-60_000);
  }, 120_000);
});
