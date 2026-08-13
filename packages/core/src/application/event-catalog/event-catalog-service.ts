import { EventNotFoundError, PromoterAssignmentNotFoundError } from '../../domain/errors.js';
import {
  createTicketTier,
  createPromoCode,
  createTablePackage,
  createPromoterAssignment,
  endPromoterAssignment,
  type PromoDiscountType,
  type PromoType,
  type TicketTier,
  type PromoCode,
  type TablePackage,
  type PromoterAssignment,
  type CommissionTerms,
} from '../../domain/models/event-catalog.js';

import type { EntityId } from '../../domain/identity.js';
import type { EventCatalogRepository, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateTierCommand {
  eventId: EntityId;
  name: string;
  description?: string;
  entryType?: string;
  currency?: string;
  priceInPaise: number;
  quantity: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  minPerOrder?: number | null;
  maxPerOrder?: number | null;
}

export interface CreatePromotionCommand {
  eventId: EntityId | null;
  code: string;
  name?: string;
  type?: PromoType;
  discountType: PromoDiscountType;
  discountValue: number;
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

export interface AssignPromoterCommand {
  eventId: EntityId;
  promoterId: EntityId;
  /** Commission terms are server-resolved (no client rates). */
  term: CommissionTerms;
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
      quantity: command.quantity,
      salesStartAt: command.salesStartAt ?? null,
      salesEndAt: command.salesEndAt ?? null,
      minPerOrder: command.minPerOrder ?? null,
      maxPerOrder: command.maxPerOrder ?? null,
      now: this.deps.config.clock.now(),
    });
    await this.repo.saveTier(tier);
    return tier;
  }

  async listTiers(actor: ActorContext, eventId: EntityId): Promise<TicketTier[]> {
    await this.assertEventOwned(actor, eventId);
    return this.repo.listTiers(eventId);
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
    const assignment = createPromoterAssignment({
      id: this.deps.config.ids(),
      eventId: command.eventId,
      promoterId: command.promoterId,
      terms: command.term,
      now: this.deps.config.clock.now(),
    });
    await this.repo.saveAssignment(assignment);
    return assignment;
  }

  async listAssignments(actor: ActorContext, eventId: EntityId): Promise<PromoterAssignment[]> {
    await this.assertEventOwned(actor, eventId);
    return this.repo.listAssignments(eventId);
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
}
