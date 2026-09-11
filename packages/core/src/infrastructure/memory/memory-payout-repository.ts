import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { Payout, PayoutStatus } from '../../domain/models/payout.js';
import type { Page, PaginationQuery, PayoutRepository } from '../../domain/ports/repositories.js';

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

  async create(payout: Payout): Promise<Payout> {
    this.payouts.set(payout.id, payout);
    return payout;
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
          (p.status === 'requested' || p.status === 'processing'),
      )
      .reduce((sum, p) => sum + p.amount, 0);
  }

  async listByStatus(status: PayoutStatus, query: PaginationQuery): Promise<Page<Payout>> {
    const all = [...this.payouts.values()].filter((p) => p.status === status);
    return serializeSlice(all, query);
  }
}
