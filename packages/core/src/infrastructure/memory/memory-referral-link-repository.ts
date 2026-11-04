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
  private recordedSales = new Set<string>();
  private recentClickIds = new Map<EntityId, Map<string, number>>();
  private globalCodes = new Map<string, EntityId>();
  private promoterCodes = new Map<EntityId, string>();
  private assignmentCodes = new Map<
    EntityId,
    { eventId: EntityId; promoterId: EntityId; code: string }
  >();
  private eventCodeClaims = new Map<string, EntityId>();
  private vanityAliases = new Map<string, EntityId>();

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

  async findByCodeGlobal(code: string): Promise<ReferralLink | null> {
    const wanted = normalizeReferralCode(code);
    for (const link of this.links.values()) if (link.code === wanted) return link;
    return null;
  }

  async findAnyByPromoter(promoterId: EntityId): Promise<ReferralLink | null> {
    for (const link of this.links.values()) {
      if (link.promoterId === promoterId) return link;
    }
    return null;
  }

  async findByVanity(prefix: string, slug: string): Promise<ReferralLink | null> {
    for (const link of this.links.values()) {
      if (link.vanityPrefix === prefix && link.vanitySlug === slug) return link;
    }
    return null;
  }

  async claimVanityAlias(prefix: string, slug: string, linkId: EntityId): Promise<boolean> {
    const key = `${prefix}/${slug}`;
    const owner = this.vanityAliases.get(key);
    if (owner && owner !== linkId) return false;
    this.vanityAliases.set(key, linkId);
    return true;
  }

  async claimGlobalCode(code: string, promoterId: EntityId): Promise<boolean> {
    const wanted = normalizeReferralCode(code);
    const owner = this.globalCodes.get(wanted);
    if (owner && owner !== promoterId) return false;
    this.globalCodes.set(wanted, promoterId);
    return true;
  }

  async getOrCreatePromoterCode(
    promoterId: EntityId,
    proposedCode: string,
  ): Promise<string | null> {
    const existing = this.promoterCodes.get(promoterId);
    const wanted = existing ?? normalizeReferralCode(proposedCode);
    const owner = this.globalCodes.get(wanted);
    if (owner && owner !== promoterId) return null;
    this.globalCodes.set(wanted, promoterId);
    if (!existing) this.promoterCodes.set(promoterId, wanted);
    return wanted;
  }

  async getOrCreateAssignmentCode(
    assignmentId: EntityId,
    eventId: EntityId,
    promoterId: EntityId,
    proposedCode: string,
  ): Promise<string | null> {
    const existing = this.assignmentCodes.get(assignmentId);
    if (existing) {
      return existing.eventId === eventId && existing.promoterId === promoterId
        ? existing.code
        : null;
    }

    const code = normalizeReferralCode(proposedCode);
    const globalOwner = this.globalCodes.get(code);
    const claimKey = `${eventId}\u0000${code}`;
    const assignmentOwner = this.eventCodeClaims.get(claimKey);
    if (
      (globalOwner && globalOwner !== promoterId) ||
      (assignmentOwner && assignmentOwner !== assignmentId)
    ) {
      return null;
    }

    this.globalCodes.set(code, promoterId);
    this.eventCodeClaims.set(claimKey, assignmentId);
    this.assignmentCodes.set(assignmentId, { eventId, promoterId, code });
    return code;
  }

  async recordClick(linkId: EntityId, clickId: string, now = new Date()): Promise<boolean> {
    const link = this.links.get(linkId);
    if (!link || !link.isActive) return false;
    const nowMs = now.getTime();
    const recent = this.recentClickIds.get(linkId) ?? new Map<string, number>();
    for (const [key, expiresAt] of recent) if (expiresAt <= nowMs) recent.delete(key);
    if (recent.has(clickId)) return false;
    recent.set(clickId, nowMs + 60_000);
    this.recentClickIds.set(linkId, recent);
    this.links.set(linkId, {
      ...link,
      clicks: link.clicks + 1,
      lastClickedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    return true;
  }

  async recordSale(
    linkId: EntityId,
    orderId: EntityId,
    revenuePaise: number,
    commissionPaise: number,
  ): Promise<void> {
    const link = this.links.get(linkId);
    if (!link || this.recordedSales.has(orderId)) return;
    this.recordedSales.add(orderId);
    this.links.set(linkId, {
      ...link,
      conversions: link.conversions + 1,
      revenuePaise: link.revenuePaise + revenuePaise,
      commissionPaise: link.commissionPaise + commissionPaise,
      updatedAt: new Date().toISOString(),
    });
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
