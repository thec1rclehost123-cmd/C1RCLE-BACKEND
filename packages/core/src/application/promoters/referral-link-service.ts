import { EventNotFoundError, InvalidOperationError } from '../../domain/errors.js';
import {
  createReferralLink,
  deactivateReferralLink,
  normalizeReferralCode,
  recordClick,
  recordConversion,
} from '../../domain/models/referral-link.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { ReferralLink } from '../../domain/models/referral-link.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Referral link service (Phase 1) ─────────────────────────────────────────
 *
 * Links carry attribution from a share to an order. They never hold money or a
 * commission rate: what an order earned is written onto the order at purchase
 * time (Phase 4), so nothing here can retroactively change a past payout.
 */

export interface CreateReferralLinkCommand {
  eventId: EntityId;
  promoterId: EntityId;
  /** Omit to have one generated. */
  code?: string;
  label?: string;
}

export class ReferralLinkService {
  constructor(private deps: ServiceDeps) {}

  private get repo() {
    return this.deps.repositories.referralLinks;
  }

  async create(actor: ActorContext, command: CreateReferralLinkCommand): Promise<ReferralLink> {
    const event = await this.deps.repositories.events.getById(command.eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      // IDOR guard: never confirm another tenant's event exists.
      throw new EventNotFoundError(command.eventId);
    }

    const link = createReferralLink({
      id: this.deps.config.ids(),
      eventId: command.eventId,
      promoterId: command.promoterId,
      organizationId: actor.organizationId,
      code: command.code,
      label: command.label,
      now: this.deps.config.clock.now(),
    });

    // Codes are the public identifier for an event's links, so a collision
    // would silently hand one promoter another's attribution.
    const clash = await this.repo.findByCode(command.eventId, link.code);
    if (clash) {
      throw new InvalidOperationError('That referral code is already in use for this event');
    }

    await this.repo.save(link);
    this.deps.logger.info('referral_link.created', {
      referralLinkId: link.id,
      eventId: command.eventId,
    });
    return link;
  }

  async listForEvent(actor: ActorContext, eventId: EntityId, query: PaginationQuery) {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      throw new EventNotFoundError(eventId);
    }
    return this.repo.listByEvent(eventId, query);
  }

  async listForPromoter(actor: ActorContext, promoterId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, actor.organizationId);
    return this.repo.listByPromoter(promoterId, query);
  }

  async deactivate(actor: ActorContext, linkId: EntityId): Promise<ReferralLink> {
    const link = await this.fetchOwned(actor, linkId);
    const deactivated = deactivateReferralLink(link, this.deps.config.clock.now());
    await this.repo.save(deactivated);
    return deactivated;
  }

  /**
   * Resolves a shared code and counts the click. Returns `null` for an unknown
   * or inactive code rather than throwing: a mistyped link on a flyer is an
   * ordinary event, not an error worth a 500 in the guest path.
   */
  async trackClick(eventId: EntityId, code: string): Promise<ReferralLink | null> {
    const link = await this.repo.findByCode(eventId, normalizeReferralCode(code));
    if (!link || !link.isActive) return null;

    const clicked = recordClick(link, this.deps.config.clock.now());
    await this.repo.save(clicked);
    return clicked;
  }

  /**
   * Counts a conversion. Called by the checkout path once an order is
   * attributed — the order carries the authoritative record, this is a
   * dashboard counter.
   */
  async recordConversion(eventId: EntityId, code: string): Promise<ReferralLink | null> {
    const link = await this.repo.findByCode(eventId, normalizeReferralCode(code));
    if (!link) return null;

    const converted = recordConversion(link, this.deps.config.clock.now());
    await this.repo.save(converted);
    return converted;
  }

  private async fetchOwned(actor: ActorContext, linkId: EntityId): Promise<ReferralLink> {
    const link = await this.repo.getById(linkId);
    if (!link || link.organizationId !== actor.organizationId) {
      throw new EventNotFoundError(linkId);
    }
    return link;
  }
}
