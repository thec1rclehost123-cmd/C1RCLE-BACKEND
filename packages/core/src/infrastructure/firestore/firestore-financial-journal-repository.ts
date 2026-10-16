import { IdempotencyConflictError } from '../../domain/errors.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { FinancialJournal, PostingSourceType } from '../../domain/models/financial-journal.js';
import type {
  FinancialJournalRepository,
  Page,
  PayableJournalLine,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { DocumentData, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';

export const JOURNAL_COLLECTION = 'v2_financial_journals';
export const JOURNAL_IDEMPOTENCY_COLLECTION = 'v2_financial_journal_idempotency';
export const JOURNAL_LINE_COLLECTION = 'v2_financial_journal_lines';

export function sameFinancialJournal(left: FinancialJournal, right: FinancialJournal): boolean {
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
        idempotencyRef: this.db
          .collection(JOURNAL_IDEMPOTENCY_COLLECTION)
          .doc(journal.idempotencyKey),
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
          const existing = financialJournalFromDocument(existingData);
          if (!sameFinancialJournal(existing, journal)) {
            throw new IdempotencyConflictError(journal.idempotencyKey);
          }
          for (const line of existing.lines) {
            tx.set(
              this.db.collection(JOURNAL_LINE_COLLECTION).doc(line.id),
              financialJournalLineDocument(existing, line),
            );
          }
          resolved.push(existing);
          return;
        }
        if (idempotencySnapshots[index]?.exists) {
          throw new IdempotencyConflictError(journal.idempotencyKey);
        }
        tx.create(this.collection.doc(journal.id), financialJournalDocument(journal));
        tx.create(idempotencyRef, { journalId: journal.id });
        for (const line of journal.lines) {
          tx.create(
            this.db.collection(JOURNAL_LINE_COLLECTION).doc(line.id),
            financialJournalLineDocument(journal, line),
          );
        }
        resolved.push(journal);
      });
      return resolved;
    });
  }

  async findById(id: EntityId): Promise<FinancialJournal | null> {
    const snapshot = await this.collection.doc(id).get();
    const data = snapshot.data();
    return data ? financialJournalFromDocument(data) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<FinancialJournal | null> {
    const idempotency = await this.db
      .collection(JOURNAL_IDEMPOTENCY_COLLECTION)
      .doc(idempotencyKey)
      .get();
    const journalId = idempotency.data()?.journalId as string | undefined;
    return journalId ? this.findById(journalId) : null;
  }

  async findBySource(
    sourceType: PostingSourceType,
    sourceId: EntityId,
  ): Promise<FinancialJournal[]> {
    const snapshot = await this.collection.where('sourceId', '==', sourceId).get();
    return snapshot.docs
      .map((document) => financialJournalFromDocument(document.data()))
      .filter((journal) => journal.source.type === sourceType);
  }

  async findByOrderId(orderId: EntityId): Promise<FinancialJournal[]> {
    const snapshot = await this.collection.where('orderId', '==', orderId).get();
    return snapshot.docs.map((document) => financialJournalFromDocument(document.data()));
  }

  async findReversals(journalId: EntityId): Promise<FinancialJournal[]> {
    const snapshot = await this.collection.where('reversalOfJournalId', '==', journalId).get();
    return snapshot.docs.map((document) => financialJournalFromDocument(document.data()));
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<FinancialJournal>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('postedAt', 'desc');
    return paginateQuery(base, query, financialJournalFromDocument);
  }

  async sumPayableByOrganization(organizationId: EntityId): Promise<number> {
    const snapshot = await this.db
      .collection(JOURNAL_LINE_COLLECTION)
      .where('organizationId', '==', organizationId)
      .where('account', 'in', [
        'host_payable',
        'venue_payable',
        'promoter_payable',
        'partner_payable',
      ])
      .get();
    return snapshot.docs.reduce((sum, document) => {
      const data = document.data();
      const amount = data.amountPaise as number;
      return sum + (data.side === 'credit' ? amount : -amount);
    }, 0);
  }

  async listPayableLinesByOrganization(organizationId: EntityId): Promise<PayableJournalLine[]> {
    const snapshot = await this.db
      .collection(JOURNAL_LINE_COLLECTION)
      .where('organizationId', '==', organizationId)
      .where('account', 'in', [
        'host_payable',
        'venue_payable',
        'promoter_payable',
        'partner_payable',
      ])
      .get();
    return snapshot.docs.map((document) => {
      const data = document.data();
      return {
        journalId: data.journalId as string,
        account: data.account as PayableJournalLine['account'],
        side: data.side as PayableJournalLine['side'],
        amountPaise: data.amountPaise as number,
        component: (data.component as PayableJournalLine['component']) ?? null,
        source: { ...(data.source as PayableJournalLine['source']) },
        accountingPolicy: {
          ...(data.accountingPolicy as PayableJournalLine['accountingPolicy']),
        },
        postedAt: data.postedAt as string,
      };
    });
  }
}

export function financialJournalLineDocument(
  journal: FinancialJournal,
  line: FinancialJournal['lines'][number],
) {
  return {
    ...line,
    journalId: journal.id,
    postedAt: journal.postedAt,
    source: { ...journal.source },
    accountingPolicy: { ...journal.accountingPolicy },
  };
}

export function financialJournalDocument(journal: FinancialJournal): DocumentData {
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

export function financialJournalFromDocument(data: DocumentData): FinancialJournal {
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
