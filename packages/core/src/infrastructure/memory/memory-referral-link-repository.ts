import { normalizeReferralCode } from '../../domain/models/referral-link.js';

import type { EntityId } from '../../domain/identity.js';
import type { ReferralLink } from '../../domain/models/referral-link.js';
import type {
  Page,
  PaginationQuery,
  ReferralLinkRepository,
  TxContext,
} from '../../domain/ports/repositories.js';

/** In-memory referral links (dev/test adapter). */
export class MemoryReferralLinkRepository implements ReferralLinkRepository {
  links = new Map<EntityId, ReferralLink>();

  async getById(linkId: EntityId): Promise<ReferralLink | null> {
    return this.links.get(linkId) ?? null;
  }

  async findByCode(eventId: EntityId, code: string): Promise<ReferralLink | null> {
    const wanted = normalizeReferralCode(code);
    for (const link of this.links.values()) {
      if (link.eventId === eventId && link.code === wanted) return link;
    }
    return null;
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<ReferralLink>> {
    return this.page(
      [...this.links.values()].filter((link) => link.eventId === eventId),
      query,
    );
  }

  async listByPromoter(promoterId: EntityId, query: PaginationQuery): Promise<Page<ReferralLink>> {
    return this.page(
      [...this.links.values()].filter((link) => link.promoterId === promoterId),
      query,
    );
  }

  async save(link: ReferralLink, _tx?: TxContext | null): Promise<void> {
    this.links.set(link.id, link);
  }

  private page(all: ReferralLink[], query: PaginationQuery): Page<ReferralLink> {
    const sorted = all.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const items = sorted.slice(offset, offset + query.limit);
    const next = offset + items.length;
    return { items, total: sorted.length, nextCursor: next < sorted.length ? String(next) : null };
  }
}
