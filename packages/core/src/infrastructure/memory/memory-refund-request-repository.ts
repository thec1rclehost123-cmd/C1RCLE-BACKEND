import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  AdminRefundRequest,
  AdminRefundRequestStatus,
} from '../../domain/models/refund-request.js';
import type {
  Page,
  PaginationQuery,
  AdminRefundRequestRepository,
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

export class MemoryRefundRequestRepository implements AdminRefundRequestRepository {
  requests = new Map<EntityId, AdminRefundRequest>();

  async getById(id: EntityId): Promise<AdminRefundRequest | null> {
    return this.requests.get(id) ?? null;
  }

  async listByOrder(orderId: EntityId): Promise<AdminRefundRequest[]> {
    return [...this.requests.values()].filter((r) => r.orderId === orderId);
  }

  async listByStatus(
    status: AdminRefundRequestStatus | null,
    query: PaginationQuery,
  ): Promise<Page<AdminRefundRequest>> {
    const all = [...this.requests.values()].filter((r) => !status || r.status === status);
    return serializeSlice(all, query);
  }

  async save(request: AdminRefundRequest): Promise<void> {
    const existing = this.requests.get(request.id);
    if (existing && existing.version !== request.version - 1) {
      throw new VersionConflictError(request.version - 1, existing.version);
    }
    this.requests.set(request.id, request);
  }
}
