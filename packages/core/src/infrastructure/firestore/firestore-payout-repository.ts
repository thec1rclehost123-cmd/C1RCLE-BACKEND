import { InvalidOperationError, VersionConflictError } from '../../domain/errors.js';

import {
  financialJournalDocument,
  financialJournalFromDocument,
  financialJournalLineDocument,
  JOURNAL_COLLECTION,
  JOURNAL_IDEMPOTENCY_COLLECTION,
  JOURNAL_LINE_COLLECTION,
  sameFinancialJournal,
} from './firestore-financial-journal-repository.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { FinancialJournal } from '../../domain/models/financial-journal.js';
import type { Payout, PayoutStatus } from '../../domain/models/payout.js';
import type { Page, PaginationQuery, PayoutRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';

const PAYOUT_COLLECTION = 'v2_payouts';

export class FirestorePayoutRepository implements PayoutRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(PAYOUT_COLLECTION);
  }

  async create(payout: Payout): Promise<Payout> {
    await this.collection.doc(payout.id).set(toDoc(payout));
    return payout;
  }

  async createWithinLimit(
    payout: Payout,
    payableLimitPaise: number,
    reservationJournal: FinancialJournal,
  ): Promise<Payout> {
    const reference = this.collection.doc(payout.id);
    return this.db.runTransaction(async (tx) => {
      const existing = await tx.get(reference);
      const existingData = existing.data();
      const idempotencyReference = this.db
        .collection(JOURNAL_IDEMPOTENCY_COLLECTION)
        .doc(reservationJournal.idempotencyKey);
      const idempotency = await tx.get(idempotencyReference);
      const existingJournalId = idempotency.data()?.journalId as string | undefined;
      const existingJournal = existingJournalId
        ? await tx.get(this.db.collection(JOURNAL_COLLECTION).doc(existingJournalId))
        : null;
      const existingJournalData = existingJournal?.data();
      if (existingJournalData) {
        const stored = financialJournalFromDocument(existingJournalData);
        if (!sameFinancialJournal(stored, reservationJournal)) {
          throw new InvalidOperationError('Payout reservation idempotency conflict');
        }
      }
      if (existingData && existingJournalData) {
        return toPayout(existingData);
      }
      const snapshot = await tx.get(
        this.collection.where('organizationId', '==', payout.organizationId),
      );
      const committed = snapshot.docs
        .map((document) => toPayout(document.data()))
        .filter((item) => ['requested', 'processing', 'frozen', 'paid'].includes(item.status))
        .reduce((sum, item) => sum + item.amount, 0);
      // The query already includes an existing payout row when repairing a
      // missing reservation journal, so only add the amount for a new row.
      const additionalCommitment = existingData ? 0 : payout.amount;
      if (committed + additionalCommitment > payableLimitPaise) {
        throw new InvalidOperationError('Concurrent payout reservation exceeds available balance');
      }
      if (!existingData) tx.create(reference, toDoc(payout));
      if (!existingJournalId) {
        tx.create(
          this.db.collection(JOURNAL_COLLECTION).doc(reservationJournal.id),
          financialJournalDocument(reservationJournal),
        );
        tx.create(idempotencyReference, { journalId: reservationJournal.id });
        for (const line of reservationJournal.lines) {
          tx.create(
            this.db.collection(JOURNAL_LINE_COLLECTION).doc(line.id),
            financialJournalLineDocument(reservationJournal, line),
          );
        }
      }
      return payout;
    });
  }

  async findById(id: EntityId): Promise<Payout | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toPayout(data) : null;
  }

  async save(payout: Payout): Promise<Payout> {
    const ref = this.collection.doc(payout.id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data) {
        const existing = toPayout(data);
        if (existing.version !== payout.version - 1) {
          throw new VersionConflictError(payout.version - 1, existing.version);
        }
      }
      tx.set(ref, toDoc(payout));
      return payout;
    });
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Payout>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toPayout);
  }

  async sumPaidByOrganization(organizationId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('organizationId', '==', organizationId)
      .where('status', '==', 'paid')
      .get();
    return snap.docs.reduce((sum, doc) => sum + (doc.data().amount as number), 0);
  }

  async sumRequestedOrProcessingByOrganization(organizationId: EntityId): Promise<number> {
    const snap = await this.collection.where('organizationId', '==', organizationId).get();
    return snap.docs
      .map((doc) => toPayout(doc.data()))
      .filter((p) => p.status === 'requested' || p.status === 'processing' || p.status === 'frozen')
      .reduce((sum, p) => sum + p.amount, 0);
  }

  async listByStatus(status: PayoutStatus | null, query: PaginationQuery): Promise<Page<Payout>> {
    const base: Query = status
      ? this.collection.where('status', '==', status).orderBy('createdAt', 'desc')
      : this.collection.orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toPayout);
  }
}

function toDoc(payout: Payout): DocumentData {
  return {
    id: payout.id,
    organizationId: payout.organizationId,
    bankAccountId: payout.bankAccountId,
    amount: payout.amount,
    status: payout.status,
    failureReason: payout.failureReason,
    requestedBy: payout.requestedBy,
    processedAt: payout.processedAt,
    transferReference: payout.transferReference,
    transferredAt: payout.transferredAt,
    transferMethod: payout.transferMethod,
    transferProof: payout.transferProof ? { ...payout.transferProof } : null,
    approvedBy: payout.approvedBy,
    previousStatus: payout.previousStatus,
    version: payout.version,
    createdAt: payout.createdAt,
    updatedAt: payout.updatedAt,
  };
}

function toPayout(data: DocumentData): Payout {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    bankAccountId: data.bankAccountId as string,
    amount: data.amount as number,
    status: data.status as PayoutStatus,
    failureReason: data.failureReason as string | null,
    requestedBy: data.requestedBy as string,
    processedAt: data.processedAt as string | null,
    transferReference: (data.transferReference as string | null | undefined) ?? null,
    transferredAt: (data.transferredAt as string | null | undefined) ?? null,
    transferMethod: (data.transferMethod as string | null | undefined) ?? null,
    transferProof: data.transferProof
      ? { ...(data.transferProof as NonNullable<Payout['transferProof']>) }
      : null,
    approvedBy: (data.approvedBy as string | null | undefined) ?? null,
    previousStatus: (data.previousStatus as PayoutStatus | undefined) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
