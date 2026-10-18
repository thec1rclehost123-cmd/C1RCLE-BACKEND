import { IdempotencyConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { FinancialJournal, PostingSourceType } from '../../domain/models/financial-journal.js';
import type {
  FinancialJournalRepository,
  Page,
  PayableJournalLine,
  PaginationQuery,
} from '../../domain/ports/repositories.js';

function sameJournal(left: FinancialJournal, right: FinancialJournal): boolean {
  const { postedAt: _leftPostedAt, createdAt: _leftCreatedAt, ...leftFacts } = left;
  const { postedAt: _rightPostedAt, createdAt: _rightCreatedAt, ...rightFacts } = right;
  return JSON.stringify(leftFacts) === JSON.stringify(rightFacts);
}

function page<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  const start = query.cursor ? all.findIndex((item) => item.id === query.cursor) + 1 : 0;
  const items = all.slice(start, start + query.limit);
  const last = items.at(-1);
  return {
    items,
    total: all.length,
    nextCursor: start + items.length < all.length && last ? last.id : null,
  };
}

export class MemoryFinancialJournalRepository implements FinancialJournalRepository {
  readonly journals = new Map<EntityId, FinancialJournal>();
  readonly byIdempotencyKey = new Map<string, EntityId>();

  async postBatch(journals: FinancialJournal[]): Promise<FinancialJournal[]> {
    const resolved = journals.map((journal) => {
      const existingId = this.byIdempotencyKey.get(journal.idempotencyKey);
      if (!existingId) return journal;
      const existing = this.journals.get(existingId);
      if (!existing || !sameJournal(existing, journal)) {
        throw new IdempotencyConflictError(journal.idempotencyKey);
      }
      return existing;
    });

    for (const journal of resolved) {
      if (this.byIdempotencyKey.has(journal.idempotencyKey)) continue;
      this.journals.set(journal.id, journal);
      this.byIdempotencyKey.set(journal.idempotencyKey, journal.id);
    }
    return resolved;
  }

  async findById(id: EntityId): Promise<FinancialJournal | null> {
    return this.journals.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<FinancialJournal | null> {
    const id = this.byIdempotencyKey.get(idempotencyKey);
    return id ? (this.journals.get(id) ?? null) : null;
  }

  async findBySource(
    sourceType: PostingSourceType,
    sourceId: EntityId,
  ): Promise<FinancialJournal[]> {
    return [...this.journals.values()].filter(
      (journal) => journal.source.type === sourceType && journal.source.id === sourceId,
    );
  }

  async findByOrderId(orderId: EntityId): Promise<FinancialJournal[]> {
    return [...this.journals.values()].filter((journal) => journal.source.orderId === orderId);
  }

  async findReversals(journalId: EntityId): Promise<FinancialJournal[]> {
    return [...this.journals.values()].filter(
      (journal) => journal.reversalOfJournalId === journalId,
    );
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<FinancialJournal>> {
    const all = [...this.journals.values()]
      .filter((journal) => journal.organizationId === organizationId)
      .sort((left, right) => right.postedAt.localeCompare(left.postedAt));
    return page(all, query);
  }

  async sumPayableByOrganization(organizationId: EntityId): Promise<number> {
    const payableAccounts = new Set([
      'host_payable',
      'venue_payable',
      'promoter_payable',
      'partner_payable',
    ]);
    return [...this.journals.values()].reduce(
      (sum, journal) =>
        sum +
        journal.lines
          .filter(
            (line) => line.organizationId === organizationId && payableAccounts.has(line.account),
          )
          .reduce(
            (lineSum, line) =>
              lineSum + (line.side === 'credit' ? line.amountPaise : -line.amountPaise),
            0,
          ),
      0,
    );
  }

  async listPayableLinesByOrganization(organizationId: EntityId): Promise<PayableJournalLine[]> {
    const payableAccounts = new Set([
      'host_payable',
      'venue_payable',
      'promoter_payable',
      'partner_payable',
    ]);
    return [...this.journals.values()].flatMap((journal) =>
      journal.lines
        .filter(
          (line) => line.organizationId === organizationId && payableAccounts.has(line.account),
        )
        .map((line) => ({
          journalId: journal.id,
          account: line.account as PayableJournalLine['account'],
          side: line.side,
          amountPaise: line.amountPaise,
          component: line.component,
          source: { ...journal.source },
          accountingPolicy: { ...journal.accountingPolicy },
          postedAt: journal.postedAt,
        })),
    );
  }
}
