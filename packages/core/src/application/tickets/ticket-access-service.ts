import { createHash, randomBytes } from 'node:crypto';

import {
  EventNotFoundError,
  ForbiddenError,
  NotFoundError,
  TicketTierNotFoundError,
  UnauthorizedError,
} from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { createTicketAccessCode } from '../../domain/models/ticket-access.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { TicketAccessCode, TicketAccessGrant } from '../../domain/models/ticket-access.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateTicketAccessCodeCommand {
  eventId: EntityId;
  scope?: 'tiers' | 'event';
  tierIds: EntityId[];
  startsAt: string;
  expiresAt: string;
  maxRedemptions: number;
}

export interface CreateTicketAccessInvitationCommand extends Omit<
  CreateTicketAccessCodeCommand,
  'maxRedemptions'
> {
  recipientEmail: string;
}

export class TicketAccessService {
  constructor(private readonly deps: ServiceDeps) {}

  async createCode(
    actor: ActorContext,
    command: CreateTicketAccessCodeCommand,
  ): Promise<{ code: string; accessCode: TicketAccessCode }> {
    if (this.deps.config.features.m5PrivateAccess !== true) {
      throw new ForbiddenError('Private ticket access is not enabled');
    }
    const event = await this.deps.repositories.events.getById(command.eventId);
    if (!event) throw new EventNotFoundError(command.eventId);
    requireOrgAccess(actor, event.organizationId);
    const userId = actor.userId;
    if (!userId) throw new UnauthorizedError('A session is required to create access codes');

    if (
      (command.scope ?? 'tiers') === 'event' &&
      (event.visibilityMode !== 'code' || command.maxRedemptions < 1)
    ) {
      throw new TicketTierNotFoundError(command.eventId);
    }

    for (const tierId of command.tierIds) {
      const tier = await this.deps.repositories.catalog.getTierById(tierId);
      if (
        !tier ||
        tier.eventId !== event.id ||
        tier.accessMode !== 'code' ||
        tier.priceInPaise <= 0 ||
        tier.accessType === 'RSVP'
      ) {
        throw new TicketTierNotFoundError(tierId);
      }
    }

    // The code is generated with high entropy, shown once, and only its SHA-256
    // verifier is persisted. It is kept out of aggregate/event/log payloads.
    const code = randomBytes(24).toString('base64url');
    const codeHash = createHash('sha256').update(code).digest('hex');
    const accessCode = createTicketAccessCode({
      id: codeHash,
      scope: command.scope ?? 'tiers',
      eventId: event.id,
      organizationId: event.organizationId,
      tierIds: command.tierIds,
      createdBy: userId,
      startsAt: command.startsAt,
      expiresAt: command.expiresAt,
      maxRedemptions: command.maxRedemptions,
      now: this.deps.config.clock.now(),
    });
    await this.deps.repositories.ticketAccess.createCode(accessCode);
    return { code, accessCode };
  }

  async createInvitation(
    actor: ActorContext,
    command: CreateTicketAccessInvitationCommand,
  ): Promise<{ code: string; accessCode: TicketAccessCode }> {
    if (this.deps.config.features.m5PrivateAccess !== true) {
      throw new ForbiddenError('Private ticket access is not enabled');
    }
    const event = await this.deps.repositories.events.getById(command.eventId);
    if (!event) throw new EventNotFoundError(command.eventId);
    requireOrgAccess(actor, event.organizationId);
    const userId = actor.userId;
    if (!userId) throw new UnauthorizedError('A session is required to create invitations');
    if ((command.scope ?? 'tiers') === 'event' && event.visibilityMode !== 'invited') {
      throw new TicketTierNotFoundError(command.eventId);
    }
    for (const tierId of command.tierIds) {
      const tier = await this.deps.repositories.catalog.getTierById(tierId);
      if (
        !tier ||
        tier.eventId !== event.id ||
        tier.accessMode !== 'invited' ||
        tier.priceInPaise <= 0 ||
        tier.accessType === 'RSVP'
      ) {
        throw new TicketTierNotFoundError(tierId);
      }
    }
    const recipientEmail = command.recipientEmail.trim().toLowerCase();
    const recipientEmailHash = createHash('sha256').update(recipientEmail).digest('hex');
    const code = randomBytes(24).toString('base64url');
    const codeHash = createHash('sha256').update(code).digest('hex');
    const accessCode = createTicketAccessCode({
      id: codeHash,
      kind: 'invitation',
      scope: command.scope ?? 'tiers',
      recipientEmailHash,
      eventId: event.id,
      organizationId: event.organizationId,
      tierIds: command.tierIds,
      createdBy: userId,
      startsAt: command.startsAt,
      expiresAt: command.expiresAt,
      maxRedemptions: 1,
      now: this.deps.config.clock.now(),
    });
    await this.deps.repositories.ticketAccess.createCode(accessCode);
    return { code, accessCode };
  }

  async listCodes(actor: ActorContext, eventId: EntityId, query: PaginationQuery) {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event) throw new EventNotFoundError(eventId);
    requireOrgAccess(actor, event.organizationId);
    return this.deps.repositories.ticketAccess.listCodesByEvent(eventId, query);
  }

  async revokeCode(
    actor: ActorContext,
    eventId: EntityId,
    codeId: EntityId,
    reason: string,
  ): Promise<TicketAccessCode> {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event) throw new EventNotFoundError(eventId);
    requireOrgAccess(actor, event.organizationId);
    const existing = await this.deps.repositories.ticketAccess.getCodeById(codeId);
    if (!existing || existing.eventId !== eventId) {
      throw new NotFoundError('Access code', codeId);
    }
    const code = await this.deps.repositories.ticketAccess.revokeCode(
      codeId,
      actor.userId,
      reason,
      this.deps.config.clock.now(),
    );
    if (!code) throw new NotFoundError('Access code', codeId);
    return code;
  }

  async redeemCode(actor: ActorContext, submittedCode: string): Promise<TicketAccessGrant> {
    if (this.deps.config.features.m5PrivateAccess !== true) {
      throw new NotFoundError('Access code', 'unavailable');
    }
    if (!actor.userId)
      throw new UnauthorizedError('A session is required to redeem an access code');
    const account = await this.deps.repositories.users.getById(actor.userId);
    if (!account?.emailVerified) {
      throw new ForbiddenError('A verified account is required to redeem an access code');
    }
    const normalizedCode = submittedCode.trim();
    const codeHash = createHash('sha256').update(normalizedCode).digest('hex');
    const grantId = createHash('sha256').update(`${codeHash}:${actor.userId}`).digest('hex');
    const recipientEmailHash = createHash('sha256')
      .update(account.email.trim().toLowerCase())
      .digest('hex');
    const code = await this.deps.repositories.ticketAccess.getCodeById(codeHash);
    if (!code) throw new NotFoundError('Access code', 'unavailable');
    const grantEvent = domainEvent({
      id: deterministicDomainEventId('ticket.access.granted', grantId),
      type: 'ticket.access.granted',
      aggregateId: grantId,
      organizationId: code.organizationId,
      actorId: actor.userId,
      occurredAt: this.deps.config.clock.now().getTime(),
      payload: {
        grantId,
        eventId: code.eventId,
        scope: code.scope ?? 'tiers',
        tierIds: [...code.tierIds],
      },
    });
    const result = await this.deps.repositories.ticketAccess.redeem({
      codeId: codeHash,
      grantId,
      userId: actor.userId,
      recipientEmailHash,
      now: this.deps.config.clock.now(),
      outboxEvent: grantEvent,
    });
    if (!result) throw new NotFoundError('Access code', 'unavailable');
    await this.deps.outbox.append(grantEvent);
    return result.grant;
  }

  async hasGrantForTier(
    grantId: EntityId,
    userId: EntityId,
    eventId: EntityId,
    tierId: EntityId,
    now: Date = this.deps.config.clock.now(),
  ): Promise<boolean> {
    if (this.deps.config.features.m5PrivateAccess !== true) return false;
    const grant = await this.deps.repositories.ticketAccess.getGrantById(grantId);
    if (
      !grant ||
      grant.userId !== userId ||
      grant.eventId !== eventId ||
      !grant.tierIds.includes(tierId) ||
      Date.parse(grant.expiresAt) <= now.getTime()
    ) {
      return false;
    }
    const code = await this.deps.repositories.ticketAccess.getCodeById(grant.codeId);
    return Boolean(
      code &&
      code.eventId === eventId &&
      code.organizationId === grant.organizationId &&
      code.status === 'active' &&
      Date.parse(code.startsAt) <= now.getTime() &&
      Date.parse(code.expiresAt) > now.getTime() &&
      code.tierIds.includes(tierId),
    );
  }

  async hasGrantForEvent(
    grantId: EntityId,
    userId: EntityId,
    eventId: EntityId,
    expectedKind?: 'code' | 'invitation',
    now: Date = this.deps.config.clock.now(),
  ): Promise<boolean> {
    if (this.deps.config.features.m5PrivateAccess !== true) return false;
    const grant = await this.deps.repositories.ticketAccess.getGrantById(grantId);
    if (
      !grant ||
      (grant.scope ?? 'tiers') !== 'event' ||
      grant.userId !== userId ||
      grant.eventId !== eventId ||
      Date.parse(grant.expiresAt) <= now.getTime()
    ) {
      return false;
    }
    const code = await this.deps.repositories.ticketAccess.getCodeById(grant.codeId);
    return Boolean(
      code &&
      (code.scope ?? 'tiers') === 'event' &&
      code.eventId === eventId &&
      code.organizationId === grant.organizationId &&
      (expectedKind === undefined || code.kind === expectedKind) &&
      grant.tierIds.every((tierId) => code.tierIds.includes(tierId)) &&
      code.status === 'active' &&
      Date.parse(code.startsAt) <= now.getTime() &&
      Date.parse(code.expiresAt) > now.getTime(),
    );
  }
}
