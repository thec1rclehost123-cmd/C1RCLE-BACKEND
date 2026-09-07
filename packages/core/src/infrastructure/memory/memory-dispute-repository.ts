import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { Dispute } from '../../domain/models/dispute.js';
import type { DisputeRepository, Page, PaginationQuery } from '../../domain/ports/repositories.js';

function serializeSlice<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const last = items[items.length - 1];
  const nextCursor = end < all.length && last ? last.id : null;
  return { items, total: all.length, nextCursor };
}

export class MemoryDisputeRepository implements DisputeRepository {
  disputes = new Map<EntityId, Dispute>();

  async create(dispute: Dispute): Promise<Dispute> {
    this.disputes.set(dispute.id, dispute);
    return dispute;
  }

  async findById(id: EntityId): Promise<Dispute | null> {
    return this.disputes.get(id) ?? null;
  }

  async save(dispute: Dispute): Promise<Dispute> {
    const existing = this.disputes.get(dispute.id);
    if (existing && existing.version !== dispute.version - 1) {
      throw new VersionConflictError(dispute.version - 1, existing.version);
    }
    this.disputes.set(dispute.id, dispute);
    return dispute;
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery & { status?: Dispute['status'] },
  ): Promise<Page<Dispute>> {
    const all = [...this.disputes.values()].filter(
      (d) => d.organizationId === organizationId && (!query.status || d.status === query.status),
    );
    return serializeSlice(all, query);
  }
}
