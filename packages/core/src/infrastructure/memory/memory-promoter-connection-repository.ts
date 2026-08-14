import { isConnectionLive } from '../../domain/models/promoter-connection.js';

import type { EntityId } from '../../domain/identity.js';
import type { PromoterConnection } from '../../domain/models/promoter-connection.js';
import type {
  Page,
  PaginationQuery,
  PromoterConnectionRepository,
  TxContext,
} from '../../domain/ports/repositories.js';

/** In-memory promoter connections (dev/test adapter). */
export class MemoryPromoterConnectionRepository implements PromoterConnectionRepository {
  connections = new Map<EntityId, PromoterConnection>();

  async getById(connectionId: EntityId): Promise<PromoterConnection | null> {
    return this.connections.get(connectionId) ?? null;
  }

  /** Live one wins; otherwise the most recent, so a block is still visible. */
  async findByPair(promoterId: EntityId, targetId: EntityId): Promise<PromoterConnection | null> {
    const matches = [...this.connections.values()]
      .filter(
        (connection) => connection.promoterId === promoterId && connection.targetId === targetId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return matches.find(isConnectionLive) ?? matches[0] ?? null;
  }

  async listForOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<PromoterConnection>> {
    const all = [...this.connections.values()]
      .filter(
        (connection) =>
          connection.promoterId === organizationId || connection.targetId === organizationId,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const items = all.slice(offset, offset + query.limit);
    const next = offset + items.length;
    return { items, total: all.length, nextCursor: next < all.length ? String(next) : null };
  }

  async save(connection: PromoterConnection, _tx?: TxContext | null): Promise<void> {
    this.connections.set(connection.id, connection);
  }
}
