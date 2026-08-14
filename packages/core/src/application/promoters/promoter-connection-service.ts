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
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ConnectionInitiator,
  ConnectionTargetType,
  PromoterConnection,
} from '../../domain/models/promoter-connection.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

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
    return connection;
  }

  async listForOrganization(actor: ActorContext, organizationId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, organizationId);
    return this.repo.listForOrganization(organizationId, query);
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
