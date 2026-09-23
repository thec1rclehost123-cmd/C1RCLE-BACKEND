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
import { requireOrgAccess, emit } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Partnership, PartnershipInitiator } from '../../domain/models/partnership.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * A partnership plus the public-safe display names the dashboard renders.
 * Names are resolved server-side so the UI never fabricates them (and never
 * falls back to `Host A1B2C3` ID labels when the data exists). A deleted
 * counterparty reads as `null`, which the frontend already renders as an
 * ID-derived label.
 */
export interface PartnershipWithNames {
  partnership: Partnership;
  hostName: string | null;
  hostSlug: string | null;
  venueName: string | null;
  venueSlug: string | null;
  venueCity: string | null;
}

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
  /**
   * Required when `initiatedBy` is `'venue'`: the host organization being
   * invited (a venueId alone cannot identify which host is wanted). Ignored
   * for host-initiated requests, where the host is the actor's own org.
   */
  hostOrganizationId?: EntityId;
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

    // A venue-initiated request must come from the tenant that owns the venue,
    // and must name the host being invited — without it the host side would
    // default to the venue's own org and every venue invite would fail as
    // "cannot partner with itself".
    if (command.initiatedBy === 'venue' && venue.organizationId !== actor.organizationId) {
      throw new ForbiddenError('Only the venue owner can invite a host to this venue');
    }
    const hostOrganizationId =
      command.initiatedBy === 'host' ? actor.organizationId : this.needHostOrganizationId(command);
    const venueOrganizationId = venue.organizationId;

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

    // Notification producer: the recipient is the OTHER party (host asks a
    // venue → the venue's org is notified; venue invites a host → the host's
    // org is). Names are emitter-resolved so the inbox consumer does no
    // fan-out. `emit` resolves `organizationId` from the ACTOR, so the
    // consumer must read the recipient from the payload, not the event.
    const [venueForNotify, hostOrgForNotify] = await Promise.all([
      this.deps.repositories.venues.getById(command.venueId),
      this.deps.repositories.organizations.getById(hostOrganizationId),
    ]);
    const venueName = venueForNotify?.public.name ?? venueOrganizationId;
    const hostName = hostOrgForNotify?.name ?? hostOrganizationId;
    await emit(this.deps, actor, partnership.id, 'partnership.requested', {
      partnershipId: partnership.id,
      venueId: command.venueId,
      venueOrganizationId,
      hostOrganizationId,
      initiatedBy: partnership.initiatedBy,
      venueName,
      hostName,
    });
    return partnership;
  }

  /**
   * The host being invited for a venue-initiated request. A standalone guard
   * so the missing-id case throws a domain error with no null assertion at
   * the call site.
   */
  private needHostOrganizationId(command: RequestPartnershipCommand): EntityId {
    const id = command.hostOrganizationId;
    if (id === undefined) {
      throw new InvalidOperationError(
        'hostOrganizationId is required for a venue-initiated invite',
      );
    }
    return id;
  }

  async listForOrganization(actor: ActorContext, organizationId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, organizationId);
    return this.repo.listForOrganization(organizationId, query);
  }

  /**
   * Same page as `listForOrganization` with counterparty names resolved.
   * One bounded fan-out per row (org + venue lookups, page size ≤ 100) —
   * cheap enough for a dashboard list, and keeps fabrication out of the UI.
   */
  async listWithNames(
    actor: ActorContext,
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<PartnershipWithNames>> {
    const page = await this.listForOrganization(actor, organizationId, query);
    const items = await Promise.all(
      page.items.map(async (partnership): Promise<PartnershipWithNames> => {
        const [hostOrg, venue, venueOrg] = await Promise.all([
          this.deps.repositories.organizations.getById(partnership.hostOrganizationId),
          this.deps.repositories.venues.getById(partnership.venueId),
          this.deps.repositories.organizations.getById(partnership.venueOrganizationId),
        ]);
        return {
          partnership,
          hostName: hostOrg?.name ?? null,
          hostSlug: hostOrg?.slug ?? null,
          venueName: venue?.public.name ?? venueOrg?.name ?? null,
          venueSlug: venue?.public.slug ?? venueOrg?.slug ?? null,
          venueCity: venue?.public.address?.city ?? null,
        };
      }),
    );
    return { ...page, items };
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
