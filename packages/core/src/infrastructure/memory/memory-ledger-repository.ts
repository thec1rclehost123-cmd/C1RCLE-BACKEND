import type { EntityId } from '../../domain/identity.js';
import type { LedgerEntry, LedgerEntryType } from '../../domain/models/ledger.js';
import type { LedgerRepository, Page, PaginationQuery } from '../../domain/ports/repositories.js';

function serializeSlice<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const last = items[items.length - 1];
  const nextCursor = end < all.length && last ? last.id : null;
  return { items, total: all.length, nextCursor };
}

export class MemoryLedgerRepository implements LedgerRepository {
  entries = new Map<EntityId, LedgerEntry>();
  byIdempotencyKey = new Map<string, EntityId>();

  async createBatch(entries: LedgerEntry[]): Promise<LedgerEntry[]> {
    for (const entry of entries) {
      if (this.byIdempotencyKey.has(entry.idempotencyKey)) continue;
      this.entries.set(entry.id, entry);
      this.byIdempotencyKey.set(entry.idempotencyKey, entry.id);
    }
    return entries;
  }

  async findByOrder(orderId: EntityId): Promise<LedgerEntry[]> {
    return [...this.entries.values()].filter((e) => e.orderId === orderId);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<LedgerEntry | null> {
    const id = this.byIdempotencyKey.get(idempotencyKey);
    if (!id) return null;
    return this.entries.get(id) ?? null;
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<LedgerEntry>> {
    const all = [...this.entries.values()].filter((e) => e.organizationId === organizationId);
    return serializeSlice(all, query);
  }

  async sumByOrganizationAndType(
    organizationId: EntityId,
  ): Promise<Record<LedgerEntryType, { pending: number; settled: number; paidOut: number }>> {
    const result: Record<LedgerEntryType, { pending: number; settled: number; paidOut: number }> = {
      ticket_revenue: { pending: 0, settled: 0, paidOut: 0 },
      platform_fee: { pending: 0, settled: 0, paidOut: 0 },
      venue_share: { pending: 0, settled: 0, paidOut: 0 },
      host_payout: { pending: 0, settled: 0, paidOut: 0 },
      promoter_commission: { pending: 0, settled: 0, paidOut: 0 },
      refund: { pending: 0, settled: 0, paidOut: 0 },
    };
    for (const entry of this.entries.values()) {
      if (entry.organizationId !== organizationId) continue;
      const bucket = result[entry.entryType];
      if (entry.status === 'pending') bucket.pending += entry.amount;
      else if (entry.status === 'settled') bucket.settled += entry.amount;
      else bucket.paidOut += entry.amount;
    }
    return result;
  }
}
