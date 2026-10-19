import { InvalidOperationError, VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { FinancialJournal } from '../../domain/models/financial-journal.js';
import type { Payout, PayoutStatus } from '../../domain/models/payout.js';
import type {
  FinancialJournalRepository,
  Page,
  PaginationQuery,
  PayoutRepository,
} from '../../domain/ports/repositories.js';

function serializeSlice<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const last = items[items.length - 1];
  const nextCursor = end < all.length && last ? last.id : null;
  return { items, total: all.length, nextCursor };
}

export class MemoryPayoutRepository implements PayoutRepository {
  payouts = new Map<EntityId, Payout>();
  private reservationQueues = new Map<EntityId, Promise<void>>();

  constructor(private readonly financialJournals?: FinancialJournalRepository) {}

  async create(payout: Payout): Promise<Payout> {
    this.payouts.set(payout.id, payout);
    return payout;
  }

  async createWithinLimit(
    payout: Payout,
    payableLimitPaise: number,
    reservationJournal: FinancialJournal,
  ): Promise<Payout> {
    const previous = this.reservationQueues.get(payout.organizationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.reservationQueues.set(payout.organizationId, queued);
    await previous;
    try {
      const existing = this.payouts.get(payout.id);
      if (existing) return existing;
      const committed = [...this.payouts.values()]
        .filter(
          (item) =>
            item.organizationId === payout.organizationId &&
            ['requested', 'processing', 'frozen', 'paid'].includes(item.status),
        )
        .reduce((sum, item) => sum + item.amount, 0);
      if (committed + payout.amount > payableLimitPaise) {
        throw new InvalidOperationError('Concurrent payout reservation exceeds available balance');
      }
      if (!this.financialJournals) {
        throw new InvalidOperationError('Payout reservation journal repository is unavailable');
      }
      await this.financialJournals.postBatch([reservationJournal]);
      return await this.create(payout);
    } finally {
      release();
      if (this.reservationQueues.get(payout.organizationId) === queued) {
        this.reservationQueues.delete(payout.organizationId);
      }
    }
  }

  async findById(id: EntityId): Promise<Payout | null> {
    return this.payouts.get(id) ?? null;
  }

  async save(payout: Payout): Promise<Payout> {
    const existing = this.payouts.get(payout.id);
    if (existing && existing.version !== payout.version - 1) {
      throw new VersionConflictError(payout.version - 1, existing.version);
    }
    this.payouts.set(payout.id, payout);
    return payout;
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Payout>> {
    const all = [...this.payouts.values()].filter((p) => p.organizationId === organizationId);
    return serializeSlice(all, query);
  }

  async sumPaidByOrganization(organizationId: EntityId): Promise<number> {
    return [...this.payouts.values()]
      .filter((p) => p.organizationId === organizationId && p.status === 'paid')
      .reduce((sum, p) => sum + p.amount, 0);
  }

  async sumRequestedOrProcessingByOrganization(organizationId: EntityId): Promise<number> {
    return [...this.payouts.values()]
      .filter(
        (p) =>
          p.organizationId === organizationId &&
          (p.status === 'requested' || p.status === 'processing' || p.status === 'frozen'),
      )
      .reduce((sum, p) => sum + p.amount, 0);
  }

  async listByStatus(status: PayoutStatus | null, query: PaginationQuery): Promise<Page<Payout>> {
    const all = [...this.payouts.values()].filter((p) => status === null || p.status === status);
    return serializeSlice(all, query);
  }
}
