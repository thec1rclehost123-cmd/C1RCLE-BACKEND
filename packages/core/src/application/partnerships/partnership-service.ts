import {
  ForbiddenError,
  InvalidOperationError,
  PartnershipNotFoundError,
  VenueNotFoundError,
} from '../../domain/errors.js';
import {
  approvePartnership,
  blockPartnership,
  createPartnership,
  endPartnership,
  isLive,
  isPartyTo,
  rejectPartnership,
} from '../../domain/models/partnership.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Partnership, PartnershipInitiator } from '../../domain/models/partnership.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Partnership service (Phase 1) ───────────────────────────────────────────
 *
 * Orchestration only: every rule about who may do what to a partnership lives
 * in `domain/models/partnership.ts`. This layer resolves the counterparty from
 * storage and enforces tenancy.
 */

export interface RequestPartnershipCommand {
  /** The venue being approached (or offering). */
  venueId: EntityId;
  /**
   * Which side the ACTOR is. A host asks a venue for a slot relationship; a
   * venue invites a host to work with it. Derived from the actor's own
   * organization, never accepted from the client.
   */
  initiatedBy: PartnershipInitiator;
  message?: string;
}

export class PartnershipService {
  constructor(private deps: ServiceDeps) {}

  private get repo() {
    return this.deps.repositories.partnerships;
  }

  /**
   * Opens a partnership request. The venue's owning organization is read from
   * the venue itself, so a client cannot address a request at an organization
   * that does not actually own it.
   */
  async request(actor: ActorContext, command: RequestPartnershipCommand): Promise<Partnership> {
    const venue = await this.deps.repositories.venues.getById(command.venueId);
    if (!venue) throw new VenueNotFoundError(command.venueId);

    const hostOrganizationId =
      command.initiatedBy === 'host' ? actor.organizationId : venue.organizationId;
    const venueOrganizationId = venue.organizationId;

    // A venue-initiated request must come from the tenant that owns the venue.
    if (command.initiatedBy === 'venue' && venue.organizationId !== actor.organizationId) {
      throw new ForbiddenError('Only the venue owner can invite a host to this venue');
    }

    const existing = await this.repo.findByPair(hostOrganizationId, command.venueId);
    if (existing && isLive(existing)) {
      // v1's "Partnership already requested or active" — one live relationship
      // per pair, so approving is never ambiguous about which request it answers.
      throw new InvalidOperationError('A live partnership already exists for this pair');
    }
    if (existing && existing.status === 'blocked') {
      // A block is terminal and must not be routed around by re-requesting.
      throw new ForbiddenError('This partnership is blocked');
    }

    const partnership = createPartnership({
      id: this.deps.config.ids(),
      hostOrganizationId,
      venueOrganizationId,
      venueId: command.venueId,
      initiatedBy: command.initiatedBy,
      message: command.message,
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(partnership);
    this.deps.logger.info('partnership.requested', {
      partnershipId: partnership.id,
      venueId: command.venueId,
    });
    return partnership;
  }

  async listForOrganization(actor: ActorContext, organizationId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, organizationId);
    return this.repo.listForOrganization(organizationId, query);
  }

  async approve(actor: ActorContext, partnershipId: EntityId): Promise<Partnership> {
    const partnership = await this.fetchParty(actor, partnershipId);
    const approved = approvePartnership(
      partnership,
      actor.organizationId,
      this.deps.config.clock.now(),
    );
    await this.repo.save(approved);
    return approved;
  }

  async reject(
    actor: ActorContext,
    partnershipId: EntityId,
    reason?: string,
  ): Promise<Partnership> {
    const partnership = await this.fetchParty(actor, partnershipId);
    const rejected = rejectPartnership(
      partnership,
      actor.organizationId,
      reason,
      this.deps.config.clock.now(),
    );
    await this.repo.save(rejected);
    return rejected;
  }

  async block(actor: ActorContext, partnershipId: EntityId, reason?: string): Promise<Partnership> {
    const partnership = await this.fetchParty(actor, partnershipId);
    const blocked = blockPartnership(
      partnership,
      actor.organizationId,
      reason,
      this.deps.config.clock.now(),
    );
    await this.repo.save(blocked);
    return blocked;
  }

  async end(actor: ActorContext, partnershipId: EntityId): Promise<Partnership> {
    const partnership = await this.fetchParty(actor, partnershipId);
    const ended = endPartnership(partnership, actor.organizationId, this.deps.config.clock.now());
    await this.repo.save(ended);
    return ended;
  }

  /**
   * Loads a partnership the actor is a party to. A partnership belonging to
   * two other organizations reads as not-found — the actor has no business
   * learning it exists.
   */
  private async fetchParty(actor: ActorContext, partnershipId: EntityId): Promise<Partnership> {
    const partnership = await this.repo.getById(partnershipId);
    if (!partnership || !isPartyTo(partnership, actor.organizationId)) {
      throw new PartnershipNotFoundError(partnershipId);
    }
    return partnership;
  }
}
