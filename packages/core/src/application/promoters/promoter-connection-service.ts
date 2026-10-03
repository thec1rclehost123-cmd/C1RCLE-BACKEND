import { InvalidOperationError, PartnershipNotFoundError } from '../../domain/errors.js';
import {
  approveConnection,
  blockConnection,
  createPromoterConnection,
  isConnectionLive,
  isPartyToConnection,
  rejectConnection,
  revokeConnection,
} from '../../domain/models/promoter-connection.js';
import { requireOrgAccess, emit } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ConnectionInitiator,
  ConnectionTargetType,
  PromoterConnection,
} from '../../domain/models/promoter-connection.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * A connection plus the public-safe display names the dashboard renders.
 * Same rationale as `PartnershipWithNames`: resolved server-side, `null`
 * when the counterparty is gone.
 */
export interface PromoterConnectionWithNames {
  connection: PromoterConnection;
  promoterName: string | null;
  promoterSlug: string | null;
  targetName: string | null;
  targetSlug: string | null;
  targetCity: string | null;
}

/**
 * ─── Promoter connection service (Phase 1) ───────────────────────────────────
 *
 * The promoter↔host/venue graph. Every rule about who may answer lives in the
 * domain model; this layer resolves the pair and enforces tenancy.
 */

export interface RequestConnectionCommand {
  /** The other side. Which of the two is the promoter depends on `initiatedBy`. */
  counterpartyId: EntityId;
  targetType: ConnectionTargetType;
  initiatedBy: ConnectionInitiator;
  message?: string;
}

export class PromoterConnectionService {
  constructor(private deps: ServiceDeps) {}

  private get repo() {
    return this.deps.repositories.promoterConnections;
  }

  async request(
    actor: ActorContext,
    command: RequestConnectionCommand,
  ): Promise<PromoterConnection> {
    // The actor is always one end; which end depends on who opened it, and it
    // is derived from the session rather than accepted from the body.
    const promoterId =
      command.initiatedBy === 'promoter' ? actor.organizationId : command.counterpartyId;
    const targetId =
      command.initiatedBy === 'promoter' ? command.counterpartyId : actor.organizationId;

    const existing = await this.repo.findByPair(promoterId, targetId);
    if (existing && isConnectionLive(existing)) {
      // v1's "BUG-2" fix: block on pending OR active, not pending alone.
      throw new InvalidOperationError('A live connection already exists for this pair');
    }
    if (existing && existing.status === 'blocked') {
      throw new InvalidOperationError('This connection is blocked');
    }

    const connection = createPromoterConnection({
      id: this.deps.config.ids(),
      promoterId,
      targetId,
      targetType: command.targetType,
      initiatedBy: command.initiatedBy,
      message: command.message,
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(connection);
    this.deps.logger.info('promoter_connection.requested', { connectionId: connection.id });

    // Notification producer: the recipient is the OTHER party, resolved for
    // the inbox consumer rather than left to a read-time fan-out.
    const promoterOrg = await this.deps.repositories.organizations.getById(connection.promoterId);
    await emit(this.deps, actor, connection.id, 'promoter_connection.requested', {
      connectionId: connection.id,
      targetId,
      targetType: connection.targetType,
      initiatedBy: connection.initiatedBy,
      promoterId: connection.promoterId,
      promoterName: promoterOrg?.name ?? connection.promoterId,
      message: connection.message,
    });
    return connection;
  }

  async listForOrganization(actor: ActorContext, organizationId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, organizationId);
    return this.repo.listForOrganization(organizationId, query);
  }

  /**
   * Same page as `listForOrganization` with counterparty names resolved.
   * A constant number of batched lookups (promoter orgs + venue targets in
   * parallel, then the expanded org set once venues resolve) — never a
   * per-row fan-out, so a 100-row page costs 3 reads, not 300.
   * For venue targets the venue's own name/city wins, falling back to the
   * owning org's name when the venue row is gone.
   */
  async listWithNames(
    actor: ActorContext,
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<PromoterConnectionWithNames>> {
    const page = await this.listForOrganization(actor, organizationId, query);

    const venueTargetIds = page.items
      .filter((connection) => connection.targetType === 'venue')
      .map((connection) => connection.targetId);
    const [promoterOrgs, venueTargets] = await Promise.all([
      this.deps.repositories.organizations.getByIds(
        page.items.map((connection) => connection.promoterId),
      ),
      this.deps.repositories.venues.getByIds(venueTargetIds),
    ]);

    // Org ids the page can reference: every `targetId` (some venue targets
    // point `targetId` at the owning org instead of the venue) plus every
    // resolved venue's owner org, so the fallback chain below never misses.
    const venueOwnerIds = venueTargets.map((venue) => venue.organizationId);
    const orgIds = [...new Set([...page.items.map((c) => c.targetId), ...venueOwnerIds])];
    const targetOrgs = await this.deps.repositories.organizations.getByIds(orgIds);

    const promoterByName = new Map(promoterOrgs.map((org) => [org.id, org] as const));
    const targetOrgByName = new Map(targetOrgs.map((org) => [org.id, org] as const));
    const venueByName = new Map(venueTargets.map((venue) => [venue.id, venue] as const));

    const items = page.items.map((connection): PromoterConnectionWithNames => {
      const promoterOrg = promoterByName.get(connection.promoterId);
      if (connection.targetType === 'venue') {
        const venue = venueByName.get(connection.targetId);
        // Prefer the venue row; fall back to the org addressed by `targetId`,
        // then to the venue's owning org (parity with the old per-row logic).
        const fallbackOrg =
          targetOrgByName.get(connection.targetId) ??
          (venue ? targetOrgByName.get(venue.organizationId) : undefined);
        return {
          connection,
          promoterName: promoterOrg?.name ?? null,
          promoterSlug: promoterOrg?.slug ?? null,
          targetName: venue?.public.name ?? fallbackOrg?.name ?? null,
          targetSlug: venue?.public.slug ?? fallbackOrg?.slug ?? null,
          targetCity: venue?.public.address?.city ?? null,
        };
      }
      const targetOrg = targetOrgByName.get(connection.targetId);
      return {
        connection,
        promoterName: promoterOrg?.name ?? null,
        promoterSlug: promoterOrg?.slug ?? null,
        targetName: targetOrg?.name ?? null,
        targetSlug: targetOrg?.slug ?? null,
        targetCity: null,
      };
    });
    return { ...page, items };
  }

  async approve(actor: ActorContext, connectionId: EntityId): Promise<PromoterConnection> {
    return this.resolve(actor, connectionId, (connection, now) =>
      approveConnection(connection, actor.organizationId, now),
    );
  }

  async reject(
    actor: ActorContext,
    connectionId: EntityId,
    reason?: string,
  ): Promise<PromoterConnection> {
    return this.resolve(actor, connectionId, (connection, now) =>
      rejectConnection(connection, actor.organizationId, reason, now),
    );
  }

  async block(
    actor: ActorContext,
    connectionId: EntityId,
    reason?: string,
  ): Promise<PromoterConnection> {
    return this.resolve(actor, connectionId, (connection, now) =>
      blockConnection(connection, actor.organizationId, reason, now),
    );
  }

  async revoke(actor: ActorContext, connectionId: EntityId): Promise<PromoterConnection> {
    return this.resolve(actor, connectionId, (connection, now) =>
      revokeConnection(connection, actor.organizationId, now),
    );
  }

  private async resolve(
    actor: ActorContext,
    connectionId: EntityId,
    apply: (connection: PromoterConnection, now: Date) => PromoterConnection,
  ): Promise<PromoterConnection> {
    const connection = await this.repo.getById(connectionId);
    // A connection between two other organizations reads as not-found.
    if (!connection || !isPartyToConnection(connection, actor.organizationId)) {
      throw new PartnershipNotFoundError(connectionId);
    }
    const updated = apply(connection, this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }
}
