import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  createPostedJournal,
  DEFAULT_ACCOUNTING_POLICY,
} from '../../domain/models/financial-journal.js';
import { MemoryFinancialJournalRepository } from '../memory/memory-financial-journal-repository.js';

import { FirestoreFinancialJournalRepository } from './firestore-financial-journal-repository.js';

import type { FinancialJournalRepository } from '../../domain/ports/repositories.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
function journal(
  orderId: string,
  kind: 'original' | 'refund' | 'partner_dispute_reversal',
  amount = 1000,
) {
  const correction = kind !== 'original';
  return createPostedJournal({
    organizationId: 'partner',
    currency: 'INR',
    source: {
      type: kind === 'original' ? 'legacy_backfill' : kind,
      id: randomUUID(),
      orderId,
      eventId: 'event',
      paymentId: null,
    },
    idempotencyKey: randomUUID(),
    accountingPolicy: DEFAULT_ACCOUNTING_POLICY,
    postedAt: new Date(),
    lines: [
      {
        account: 'ticket_collection_control',
        component: null,
        memo: 'Synthetic correction regression',
        side: correction ? 'credit' : 'debit',
        amountPaise: amount,
        organizationId: 'partner',
      },
      {
        account: 'host_payable',
        component: null,
        memo: 'Synthetic correction regression',
        side: correction ? 'debit' : 'credit',
        amountPaise: amount,
        organizationId: 'partner',
      },
    ],
  });
}
async function cases(native: boolean) {
  if (native && (!emulator || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator)))
    throw new Error('Requires loopback Emulator');
  const db = native
    ? new Firestore({ projectId: `demo-m4-dispute-${randomUUID().slice(0, 8)}` })
    : null;
  const repo: FinancialJournalRepository = db
    ? new FirestoreFinancialJournalRepository(db)
    : new MemoryFinancialJournalRepository();
  const second = db ? new FirestoreFinancialJournalRepository(db) : repo;
  return {
    repo,
    second,
    cleanup: async () => {
      if (db) {
        for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
        await db.terminate();
      }
    },
  };
}
for (const native of [false, true]) {
  describe.runIf(!native || emulator)(
    `${native ? 'Native' : 'Memory'} atomic dispute/refund correction`,
    () => {
      it('rejects one competing full correction without double payable debit and permits exact replay', async () => {
        const f = await cases(native);
        try {
          const order = randomUUID();
          await f.repo.postBatch([journal(order, 'original')]);
          const dispute = journal(order, 'partner_dispute_reversal');
          const refund = journal(order, 'refund');
          const result = await Promise.allSettled([
            f.repo.postBatch([dispute]),
            f.second.postBatch([refund]),
          ]);
          expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
          expect(result.filter((item) => item.status === 'rejected')).toHaveLength(1);
          expect(await f.repo.sumPayableByOrganization('partner')).toBe(0);
          const winner = result[0]?.status === 'fulfilled' ? dispute : refund;
          await f.repo.postBatch([winner]);
          expect(await f.repo.findByOrderId(order)).toHaveLength(2);
        } finally {
          await f.cleanup();
        }
      });
      it('rejects a stale full refund then accepts only its recomputed remaining payable', async () => {
        const f = await cases(native);
        try {
          const order = randomUUID();
          await f.repo.postBatch([journal(order, 'original')]);
          await f.repo.postBatch([journal(order, 'partner_dispute_reversal', 400)]);
          await expect(f.second.postBatch([journal(order, 'refund')])).rejects.toThrow(
            'Payable correction changed concurrently',
          );
          await f.second.postBatch([journal(order, 'refund', 600)]);
          expect(await f.repo.sumPayableByOrganization('partner')).toBe(0);
          expect(await f.repo.findByOrderId(order)).toHaveLength(3);
        } finally {
          await f.cleanup();
        }
      });
    },
  );
}
