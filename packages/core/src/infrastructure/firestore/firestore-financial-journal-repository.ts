import { IdempotencyConflictError } from '../../domain/errors.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { FinancialJournal, PostingSourceType } from '../../domain/models/financial-journal.js';
import type {
  FinancialJournalRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { DocumentData, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';

const JOURNAL_COLLECTION = 'v2_financial_journals';
const IDEMPOTENCY_COLLECTION = 'v2_financial_journal_idempotency';

function sameJournal(left: FinancialJournal, right: FinancialJournal): boolean {
  const { postedAt: _leftPostedAt, createdAt: _leftCreatedAt, ...leftFacts } = left;
  const { postedAt: _rightPostedAt, createdAt: _rightCreatedAt, ...rightFacts } = right;
  return JSON.stringify(leftFacts) === JSON.stringify(rightFacts);
}

export class FirestoreFinancialJournalRepository implements FinancialJournalRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(JOURNAL_COLLECTION);
  }

  async postBatch(journals: FinancialJournal[]): Promise<FinancialJournal[]> {
    return this.db.runTransaction(async (tx) => {
      const pairs = journals.map((journal) => ({
        journal,
        idempotencyRef: this.db.collection(IDEMPOTENCY_COLLECTION).doc(journal.idempotencyKey),
      }));
      const idempotencySnapshots = await Promise.all(
        pairs.map(({ idempotencyRef }) => tx.get(idempotencyRef)),
      );
      const existingRefs = idempotencySnapshots.map((snapshot) => {
        const data = snapshot.data();
        return data ? this.collection.doc(data.journalId as string) : null;
      });
      const existingSnapshots: (DocumentSnapshot | null)[] = [];
      for (const reference of existingRefs) {
        existingSnapshots.push(reference ? await tx.get(reference) : null);
      }
      const resolved: FinancialJournal[] = [];

      pairs.forEach(({ journal, idempotencyRef }, index) => {
        const existingData = existingSnapshots[index]?.data();
        if (existingData) {
          const existing = toJournal(existingData);
          if (!sameJournal(existing, journal)) {
            throw new IdempotencyConflictError(journal.idempotencyKey);
          }
          resolved.push(existing);
          return;
        }
        if (idempotencySnapshots[index]?.exists) {
          throw new IdempotencyConflictError(journal.idempotencyKey);
        }
        tx.create(this.collection.doc(journal.id), toDoc(journal));
        tx.create(idempotencyRef, { journalId: journal.id });
        resolved.push(journal);
      });
      return resolved;
    });
  }

  async findById(id: EntityId): Promise<FinancialJournal | null> {
    const snapshot = await this.collection.doc(id).get();
    const data = snapshot.data();
    return data ? toJournal(data) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<FinancialJournal | null> {
    const idempotency = await this.db.collection(IDEMPOTENCY_COLLECTION).doc(idempotencyKey).get();
    const journalId = idempotency.data()?.journalId as string | undefined;
    return journalId ? this.findById(journalId) : null;
  }

  async findBySource(
    sourceType: PostingSourceType,
    sourceId: EntityId,
  ): Promise<FinancialJournal[]> {
    const snapshot = await this.collection.where('sourceId', '==', sourceId).get();
    return snapshot.docs
      .map((document) => toJournal(document.data()))
      .filter((journal) => journal.source.type === sourceType);
  }

  async findByOrderId(orderId: EntityId): Promise<FinancialJournal[]> {
    const snapshot = await this.collection.where('orderId', '==', orderId).get();
    return snapshot.docs.map((document) => toJournal(document.data()));
  }

  async findReversals(journalId: EntityId): Promise<FinancialJournal[]> {
    const snapshot = await this.collection.where('reversalOfJournalId', '==', journalId).get();
    return snapshot.docs.map((document) => toJournal(document.data()));
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<FinancialJournal>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('postedAt', 'desc');
    return paginateQuery(base, query, toJournal);
  }
}

function toDoc(journal: FinancialJournal): DocumentData {
  return {
    ...journal,
    lines: journal.lines.map((entry) => ({ ...entry })),
    source: { ...journal.source },
    accountingPolicy: { ...journal.accountingPolicy },
    components: journal.components ? { ...journal.components } : null,
    sourceId: journal.source.id,
    sourceType: journal.source.type,
    orderId: journal.source.orderId,
  };
}

function toJournal(data: DocumentData): FinancialJournal {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    currency: data.currency as string,
    lines: (data.lines as FinancialJournal['lines']).map((entry) => ({ ...entry })),
    source: { ...(data.source as FinancialJournal['source']) },
    idempotencyKey: data.idempotencyKey as string,
    accountingPolicy: {
      ...(data.accountingPolicy as FinancialJournal['accountingPolicy']),
    },
    components: data.components
      ? { ...(data.components as NonNullable<FinancialJournal['components']>) }
      : null,
    reversalOfJournalId: (data.reversalOfJournalId as string | null) ?? null,
    evidenceOnly: data.evidenceOnly as boolean,
    status: 'posted',
    postedAt: data.postedAt as string,
    createdAt: data.createdAt as string,
  };
}
