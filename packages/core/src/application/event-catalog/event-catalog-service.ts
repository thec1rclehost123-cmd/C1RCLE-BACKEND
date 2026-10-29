import {
  ConflictError,
  EventNotFoundError,
  InvalidOperationError,
  PromoterAssignmentNotFoundError,
  VersionConflictError,
} from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import {
  createTicketTier,
  createPromoCode,
  createTablePackage,
  createPromoterAssignment,
  effectiveTierPricePaise,
  acceptPromoterAssignment,
  endPromoterAssignment,
  expirePromoterAssignment,
  rejectPromoterAssignment,
  revokePromoterAssignment,
  type PromoDiscountType,
  type PromoType,
  type TicketTier,
  type CreateTicketPricingPhaseInput,
  type PromoCode,
  type TablePackage,
  type PromoterAssignment,
  type CommissionTerms,
} from '../../domain/models/event-catalog.js';
import { promoterCommissionFitsDistributableValue } from '../../domain/models/ledger.js';
import {
  hasCurrentPromoterAgreementAcceptance,
  PROMOTER_AGREEMENT_TEST_FIXTURE,
} from '../../domain/models/promoter-agreement.js';
import { createTicketAddon } from '../../domain/models/ticket-addon.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type { DiscountFundingOwner } from '../../domain/models/financial-journal.js';
import type { TicketAddon } from '../../domain/models/ticket-addon.js';
import type { EventCatalogRepository, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateTierCommand {
  eventId: EntityId;
  name: string;
  description?: string;
  entryType?: string;
  currency?: string;
  priceInPaise?: number;
  coverAmountPaise?: number;
  quantity: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  maxPerOrder?: number | null;
  accessType?: TicketTier['accessType'];
  audienceType?: TicketTier['audienceType'];
  guestCount?: number;
  admissionMode?: TicketTier['admissionMode'];
  accessMode?: TicketTier['accessMode'];
  pricingPhases?: CreateTicketPricingPhaseInput[];
  doorPriceInPaise?: number | null;
  benefits?: string[];
  minAge?: number | null;
  maxAge?: number | null;
  minPerOrder?: number | null;
  maxPerUser?: number | null;
  tableConfig?: TicketTier['tableConfig'];
  commissionEligible?: boolean;
}

export interface CreatePromotionCommand {
  eventId: EntityId | null;
  code: string;
  name?: string;
  type?: PromoType;
  discountType: PromoDiscountType;
  discountValue: number;
  discountFundingOwner: DiscountFundingOwner;
  tierIds?: EntityId[];
  maxRedemptions?: number | null;
  maxPerUser?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface CreateTableCommand {
  eventId: EntityId;
  name: string;
  capacity: number;
  pricePaise: number;
  minSpendPaise?: number | null;
}

export interface CreateTicketAddonCommand {
  eventId: EntityId;
  name: string;
  description?: string;
  kind: 'parking' | 'cloakroom' | 'merchandise';
  priceInPaise: number;
  quantity: number;
  maxPerEntitlement?: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
}

export interface AssignPromoterCommand {
  eventId: EntityId;
  promoterId: EntityId;
  /** Commission terms are server-resolved (no client rates). */
  term: CommissionTerms;
  startsAt?: string | null;
  expiresAt?: string | null;
  eligibleTierIds?: EntityId[];
}

export type { CommissionTerms };

export class EventCatalogService {
  constructor(private deps: ServiceDeps) {}

  private get repo(): EventCatalogRepository {
    return this.deps.repositories.catalog;
  }

  private async assertEventOwned(actor: ActorContext, eventId: EntityId): Promise<void> {
    const events = this.deps.repositories.events;
    const event = await events.getById(eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      throw new EventNotFoundError(eventId);
    }
  }

  async createTier(actor: ActorContext, command: CreateTierCommand): Promise<TicketTier> {
    await this.assertEventOwned(actor, command.eventId);
    const tier = createTicketTier({
      id: this.deps.config.ids(),
      eventId: command.eventId,
      organizationId: actor.organizationId,
      name: command.name,
      description: command.description,
      entryType: command.entryType,
      currency: command.currency,
      priceInPaise: command.priceInPaise,
      coverAmountPaise: command.coverAmountPaise,
      quantity: command.quantity,
      salesStartAt: command.salesStartAt ?? null,
      salesEndAt: command.salesEndAt ?? null,
      maxPerOrder: command.maxPerOrder ?? null,
      accessType: command.accessType,
      audienceType: command.audienceType,
      guestCount: command.guestCount,
      admissionMode: command.admissionMode,
      accessMode: command.accessMode,
      pricingPhases: command.pricingPhases,
      doorPriceInPaise: command.doorPriceInPaise,
      benefits: command.benefits,
      minAge: command.minAge,
      maxAge: command.maxAge,
      minPerOrder: command.minPerOrder,
      maxPerUser: command.maxPerUser,
      tableConfig: command.tableConfig,
      commissionEligible: command.commissionEligible,
      now: this.deps.config.clock.now(),
    });
    await this.repo.saveTier(tier);
    return tier;
  }

  async listTiers(actor: ActorContext, eventId: EntityId): Promise<TicketTier[]> {
    await this.assertEventOwned(actor, eventId);
    return this.repo.listTiers(eventId);
  }

  async createTicketAddon(
    actor: ActorContext,
    command: CreateTicketAddonCommand,
  ): Promise<TicketAddon> {
    await this.assertEventOwned(actor, command.eventId);
    const addon = createTicketAddon({
      id: this.deps.config.ids(),
      eventId: command.eventId,
      organizationId: actor.organizationId,
      name: command.name,
      description: command.description,
      kind: command.kind,
      priceInPaise: command.priceInPaise,
      quantity: command.quantity,
      maxPerEntitlement: command.maxPerEntitlement,
      salesStartAt: command.salesStartAt,
      salesEndAt: command.salesEndAt,
      now: this.deps.config.clock.now(),
    });
    await this.repo.saveTicketAddon(addon);
    return addon;
  }

  async listTicketAddons(actor: ActorContext, eventId: EntityId): Promise<TicketAddon[]> {
    await this.assertEventOwned(actor, eventId);
    return this.repo.listTicketAddons(eventId);
  }

  async createPromotion(actor: ActorContext, command: CreatePromotionCommand): Promise<PromoCode> {
    if (command.eventId !== null) await this.assertEventOwned(actor, command.eventId);
    const promo = createPromoCode({
      id: this.deps.config.ids(),
      eventId: command.eventId,
      organizationId: actor.organizationId,
      code: command.code,
      name: command.name,
      type: command.type,
      discountType: command.discountType,
      discountValue: command.discountValue,
      discountFundingOwner: command.discountFundingOwner,
      tierIds: command.tierIds,
      maxRedemptions: command.maxRedemptions ?? null,
      maxPerUser: command.maxPerUser ?? null,
      startsAt: command.startsAt ?? null,
      endsAt: command.endsAt ?? null,
      now: this.deps.config.clock.now(),
    });
    await this.repo.savePromo(promo);
    return promo;
  }

  async listPromotions(actor: ActorContext, eventId: EntityId, query: PaginationQuery) {
    await this.assertEventOwned(actor, eventId);
    return this.repo.listPromos(eventId, query);
  }

  async createTable(actor: ActorContext, command: CreateTableCommand): Promise<TablePackage> {
    await this.assertEventOwned(actor, command.eventId);
    const table = createTablePackage({
      id: this.deps.config.ids(),
      eventId: command.eventId,
      organizationId: actor.organizationId,
      name: command.name,
      capacity: command.capacity,
      pricePaise: command.pricePaise,
      minSpendPaise: command.minSpendPaise ?? null,
      now: this.deps.config.clock.now(),
    });
    await this.repo.saveTable(table);
    return table;
  }

  async listTables(actor: ActorContext, eventId: EntityId): Promise<TablePackage[]> {
    await this.assertEventOwned(actor, eventId);
    return this.repo.listTables(eventId);
  }

  async assignPromoter(
    actor: ActorContext,
    command: AssignPromoterCommand,
  ): Promise<PromoterAssignment> {
    await this.assertEventOwned(actor, command.eventId);
    const promoter = await this.deps.repositories.organizations.getById(command.promoterId);
    const onboarding = await this.deps.repositories.onboarding.findByProvisionedOrganizationId(
      command.promoterId,
    );
    const connection = await this.deps.repositories.promoterConnections.findByPair(
      command.promoterId,
      actor.organizationId,
    );
    if (
      !promoter ||
      promoter.status !== 'active' ||
      !promoter.members.some((member) => member.capabilities.includes('promoter')) ||
      onboarding?.status !== 'approved' ||
      onboarding.requestedType !== 'promoter' ||
      !hasCurrentPromoterAgreementAcceptance(
        onboarding,
        PROMOTER_AGREEMENT_TEST_FIXTURE,
        this.testAgreementFixtureAllowed(),
      ) ||
      connection?.status !== 'active'
    ) {
      throw new PromoterAssignmentNotFoundError(command.promoterId);
    }
    const eventTiers = await this.repo.listTiers(command.eventId);
    const requestedTierIds =
      command.eligibleTierIds ??
      eventTiers
        .filter((tier) => tier.commissionEligible && tier.accessType !== 'RSVP')
        .map((tier) => tier.id);
    if (requestedTierIds.length === 0 && command.eligibleTierIds !== undefined) {
      const rsvpOnlyEvent =
        eventTiers.length > 0 && eventTiers.every((tier) => tier.accessType === 'RSVP');
      const zeroCommissionTerms =
        command.term.ratePercent === 0 &&
        command.term.flatPaise === 0 &&
        Object.values(command.term.tierRates ?? {}).every(
          (terms) => terms.ratePercent === 0 && terms.flatPaise === 0,
        );
      if (!rsvpOnlyEvent || !zeroCommissionTerms) {
        throw new InvalidOperationError(
          'An assignment without commission-eligible tiers must be an RSVP-only campaign with zero commission',
        );
      }
    }
    if (
      requestedTierIds.some(
        (tierId) =>
          !eventTiers.some(
            (tier) => tier.id === tierId && tier.commissionEligible && tier.accessType !== 'RSVP',
          ),
      )
    ) {
      throw new InvalidOperationError('Commission terms include an ineligible ticket tier');
    }
    if (
      Object.keys(command.term.tierRates ?? {}).some((tierId) => !requestedTierIds.includes(tierId))
    ) {
      throw new InvalidOperationError('Commission terms include a tier outside the assignment');
    }
    const owner = await this.deps.repositories.organizations.getById(actor.organizationId);
    const event = await this.deps.repositories.events.getById(command.eventId);
    if (!owner || !event) throw new EventNotFoundError(command.eventId);
    let venueShareRate = 0;
    if (event.venueId) {
      const partnership = await this.deps.repositories.partnerships.findByPair(
        event.organizationId,
        event.venueId,
      );
      venueShareRate = (partnership?.venueShareRate ?? 0) / 100;
    }
    for (const tier of eventTiers.filter((candidate) => requestedTierIds.includes(candidate.id))) {
      const tierTerms = command.term.tierRates?.[tier.id] ?? command.term;
      const faceValue = effectiveTierPricePaise(tier);
      const commission =
        Math.floor((faceValue * tierTerms.ratePercent) / 100) + tierTerms.flatPaise;
      if (
        !promoterCommissionFitsDistributableValue(
          faceValue,
          commission,
          owner.platformFeePercent / 100,
          venueShareRate,
        )
      ) {
        throw new InvalidOperationError(
          `Promoter commission exceeds distributable ticket value for tier ${tier.id}`,
        );
      }
    }
    const existing = await this.repo.listAssignments(command.eventId);
    const now = this.deps.config.clock.now();
    if (
      existing.some(
        (assignment) =>
          assignment.promoterId === command.promoterId &&
          (assignment.status === 'suspended' ||
            ((assignment.status === 'invited' ||
              assignment.status === 'accepted' ||
              assignment.status === 'active') &&
              !(assignment.expiresAt && Date.parse(assignment.expiresAt) <= now.getTime()))),
      )
    ) {
      throw new ConflictError('An active or pending assignment already exists for this event');
    }
    const assignment = createPromoterAssignment({
      id: this.deps.config.ids(),
      eventId: command.eventId,
      promoterId: command.promoterId,
      terms: command.term,
      status: 'invited',
      invitedBy: actor.userId ?? undefined,
      startsAt: command.startsAt,
      expiresAt: command.expiresAt,
      eligibleTierIds: requestedTierIds,
      now,
    });
    await this.repo.saveAssignment(assignment);
    await this.emitAssignmentEvent('promoter.assignment.invited', actor, event, assignment);
    return assignment;
  }

  async listAssignments(actor: ActorContext, eventId: EntityId): Promise<PromoterAssignment[]> {
    await this.assertEventOwned(actor, eventId);
    return this.repo.listAssignments(eventId);
  }

  /** Approved Promoters with an active connection to this event owner. */
  async listEligiblePromoters(
    actor: ActorContext,
    eventId: EntityId,
  ): Promise<{ id: EntityId; name: string; slug: string }[]> {
    await this.assertEventOwned(actor, eventId);
    const connections = await this.deps.repositories.promoterConnections.listForOrganization(
      actor.organizationId,
      { limit: 100, cursor: null },
    );
    const activePromoterIds = [
      ...new Set(
        connections.items
          .filter(
            (connection) =>
              connection.status === 'active' && connection.targetId === actor.organizationId,
          )
          .map((connection) => connection.promoterId),
      ),
    ];
    const organizations = await this.deps.repositories.organizations.getByIds(activePromoterIds);
    const rows = await Promise.all(
      organizations.map(async (organization) => {
        const onboarding = await this.deps.repositories.onboarding.findByProvisionedOrganizationId(
          organization.id,
        );
        if (
          organization.status !== 'active' ||
          !organization.members.some((member) => member.capabilities.includes('promoter')) ||
          onboarding?.status !== 'approved' ||
          onboarding.requestedType !== 'promoter' ||
          !hasCurrentPromoterAgreementAcceptance(
            onboarding,
            PROMOTER_AGREEMENT_TEST_FIXTURE,
            this.testAgreementFixtureAllowed(),
          )
        )
          return null;
        return { id: organization.id, name: organization.name, slug: organization.slug };
      }),
    );
    return rows.filter((row): row is { id: EntityId; name: string; slug: string } => row !== null);
  }

  /** Events currently assigned to the promoter's own organization. */
  async listAssignedEvents(actor: ActorContext, promoterId: EntityId) {
    requireOrgAccess(actor, promoterId);
    const assignments = await this.repo.listAssignmentsByPromoter(promoterId);
    const active = assignments.filter(
      (assignment) => assignment.status === 'accepted' || assignment.status === 'active',
    );
    const events = await Promise.all(
      active.map(async (assignment) => ({
        assignment,
        event: await this.deps.repositories.events.getById(assignment.eventId),
      })),
    );
    return events.filter((item): item is typeof item & { event: Event } => item.event !== null);
  }

  async listPromoterInvitations(actor: ActorContext, promoterId: EntityId) {
    requireOrgAccess(actor, promoterId);
    const assignments = await this.repo.listAssignmentsByPromoter(promoterId);
    return assignments.filter((assignment) => assignment.status === 'invited');
  }

  async respondToAssignment(
    actor: ActorContext,
    assignmentId: EntityId,
    decision: 'accept' | 'reject',
    expectedVersion: number,
  ): Promise<PromoterAssignment> {
    const assignment = await this.repo.getAssignmentById(assignmentId);
    if (!assignment || assignment.promoterId !== actor.organizationId) {
      throw new PromoterAssignmentNotFoundError(assignmentId);
    }
    if (assignment.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, assignment.version);
    }
    const onboarding = await this.deps.repositories.onboarding.findByProvisionedOrganizationId(
      actor.organizationId,
    );
    if (onboarding?.status !== 'approved' || onboarding.requestedType !== 'promoter') {
      throw new PromoterAssignmentNotFoundError(assignmentId);
    }
    const next =
      decision === 'accept'
        ? acceptPromoterAssignment(
            assignment,
            actor.userId ?? actor.organizationId,
            this.deps.config.clock.now(),
          )
        : rejectPromoterAssignment(
            assignment,
            actor.userId ?? actor.organizationId,
            this.deps.config.clock.now(),
          );
    await this.repo.saveAssignment(next);
    const event = await this.deps.repositories.events.getById(assignment.eventId);
    if (event) {
      const owner = await this.deps.repositories.organizations.getById(event.organizationId);
      const ownerCapabilities = new Set(
        owner?.members.flatMap((member) => member.capabilities) ?? [],
      );
      const recipientType = ownerCapabilities.has('venue')
        ? 'venue'
        : ownerCapabilities.has('host')
          ? 'host'
          : null;
      if (recipientType) {
        await this.emitAssignmentEvent(
          `promoter.assignment.${decision === 'accept' ? 'accepted' : 'rejected'}`,
          actor,
          event,
          next,
          { eventOwnerId: event.organizationId, eventOwnerType: recipientType },
        );
      }
    }
    return next;
  }

  async endAssignment(actor: ActorContext, assignmentId: EntityId): Promise<PromoterAssignment> {
    const assignment = await this.repo.getAssignmentById(assignmentId);
    if (!assignment) throw new PromoterAssignmentNotFoundError(assignmentId);
    const events = this.deps.repositories.events;
    const event = await events.getById(assignment.eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      throw new PromoterAssignmentNotFoundError(assignmentId);
    }
    const ended = endPromoterAssignment(assignment, this.deps.config.clock.now());
    await this.repo.saveAssignment(ended);
    return ended;
  }

  async revokeAssignment(
    actor: ActorContext,
    assignmentId: EntityId,
    expectedVersion: number,
    reason: string,
  ): Promise<PromoterAssignment> {
    const assignment = await this.repo.getAssignmentById(assignmentId);
    if (!assignment) throw new PromoterAssignmentNotFoundError(assignmentId);
    const event = await this.deps.repositories.events.getById(assignment.eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      throw new PromoterAssignmentNotFoundError(assignmentId);
    }
    if (assignment.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, assignment.version);
    }
    const revoked = revokePromoterAssignment(
      assignment,
      actor.userId ?? actor.organizationId,
      reason,
      this.deps.config.clock.now(),
    );
    await this.repo.saveAssignment(revoked);
    await this.emitAssignmentEvent('promoter.assignment.revoked', actor, event, revoked);
    return revoked;
  }

  /**
   * Persists due assignment expirations and emits one durable event per
   * assignment. Each pass is capped so an overdue backlog cannot monopolize
   * the API process; another worker tick continues the backlog.
   */
  async expireDuePromoterAssignments(): Promise<number> {
    const now = this.deps.config.clock.now();
    const batchSize = 100;
    const maxBatchesPerPass = 5;
    let expiredCount = 0;

    for (let batch = 0; batch < maxBatchesPerPass; batch += 1) {
      const due = await this.repo.listExpiredAssignments(now, batchSize);
      if (due.length === 0) break;
      let progressed = 0;

      for (const candidate of due) {
        const current = await this.repo.getAssignmentById(candidate.id);
        if (!current || !current.expiresAt) continue;
        const expired = expirePromoterAssignment(current, now);
        if (expired === current) continue;

        const event = await this.deps.repositories.events.getById(current.eventId);
        const eventType = 'promoter.assignment.expired';
        await this.deps.outbox.append(
          domainEvent({
            id: deterministicDomainEventId(eventType, current.id, current.expiresAt),
            type: eventType,
            aggregateId: current.id,
            organizationId: event?.organizationId ?? current.promoterId,
            actorId: 'system',
            payload: {
              assignmentId: current.id,
              eventId: current.eventId,
              promoterId: current.promoterId,
              eventTitle: event?.title ?? null,
              expiresAt: current.expiresAt,
            },
            occurredAt: now.getTime(),
          }),
        );
        await this.repo.saveAssignment(expired);
        progressed += 1;
      }

      expiredCount += progressed;
      if (progressed === 0) break;
    }
    return expiredCount;
  }

  private async emitAssignmentEvent(
    type:
      | 'promoter.assignment.invited'
      | 'promoter.assignment.accepted'
      | 'promoter.assignment.rejected'
      | 'promoter.assignment.revoked',
    actor: ActorContext,
    event: Event,
    assignment: PromoterAssignment,
    owner?: { eventOwnerId: EntityId; eventOwnerType: 'host' | 'venue' },
  ): Promise<void> {
    const payload = {
      assignmentId: assignment.id,
      eventId: event.id,
      promoterId: assignment.promoterId,
      eventTitle: event.title,
      ...(owner ?? {}),
    };
    await this.deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId(type, assignment.id, String(assignment.version)),
        type,
        aggregateId: assignment.id,
        organizationId: event.organizationId,
        actorId: actor.userId ?? actor.organizationId,
        payload,
        occurredAt: this.deps.config.clock.now().getTime(),
      }),
    );
  }

  private testAgreementFixtureAllowed(): boolean {
    return this.deps.config.features.m4PromoterAgreementFixture === true;
  }
}
