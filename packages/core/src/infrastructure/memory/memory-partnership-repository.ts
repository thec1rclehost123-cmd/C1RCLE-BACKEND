import { isLive } from '../../domain/models/partnership.js';

import type { EntityId } from '../../domain/identity.js';
import type { Partnership } from '../../domain/models/partnership.js';
import type {
  Page,
  PaginationQuery,
  PartnershipRepository,
  TxContext,
} from '../../domain/ports/repositories.js';

/**
 * ─── In-memory partnership repository (dev/test adapter) ─────────────────────
 * Map-backed, offset cursor, zero infra imports — same shape as the other
 * Memory* repos.
 */
export class MemoryPartnershipRepository implements PartnershipRepository {
  partnerships = new Map<EntityId, Partnership>();

  async getById(partnershipId: EntityId): Promise<Partnership | null> {
    return this.partnerships.get(partnershipId) ?? null;
  }

  /**
   * The live partnership for a pair, if any; otherwise the most recent
   * resolved one — a caller needs to see a `blocked` row to know a re-request
   * is not allowed.
   */
  async findByPair(hostOrganizationId: EntityId, venueId: EntityId): Promise<Partnership | null> {
    const matches = [...this.partnerships.values()]
      .filter(
        (partnership) =>
          partnership.hostOrganizationId === hostOrganizationId && partnership.venueId === venueId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return matches.find(isLive) ?? matches[0] ?? null;
  }

  async listForOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Partnership>> {
    const all = [...this.partnerships.values()]
      .filter(
        (partnership) =>
          partnership.hostOrganizationId === organizationId ||
          partnership.venueOrganizationId === organizationId,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const items = all.slice(offset, offset + query.limit);
    const next = offset + items.length;
    return { items, total: all.length, nextCursor: next < all.length ? String(next) : null };
  }

  async save(partnership: Partnership, _tx?: TxContext | null): Promise<void> {
    this.partnerships.set(partnership.id, partnership);
  }
}
