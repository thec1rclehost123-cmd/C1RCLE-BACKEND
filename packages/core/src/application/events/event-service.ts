import { EventNotFoundError, VersionConflictError } from '../../domain/errors.js';
import { newDomainEvent } from '../../domain/events/domain-events.js';
import {
  createEvent,
  transitionEvent,
  cancelEvent,
  updateEvent,
  isPublicStatus,
  type EventStatus,
  type Event,
} from '../../domain/models/event.js';
import { requireOrgAccess } from '../context.js';

import type { DomainEventType } from '../../domain/events/domain-events.js';
import type { EntityId } from '../../domain/identity.js';
import type { EventRepository, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateEventCommand {
  venueId: EntityId;
  title: string;
  summary?: string;
  description?: string;
  startAt: string;
  endAt?: string | null;
  tags?: string[];
}

export interface UpdateEventCommand {
  eventId: EntityId;
  expectedVersion: number | null;
  changes: {
    title?: string;
    summary?: string;
    description?: string;
    startAt?: string;
    endAt?: string | null;
    tags?: string[];
  };
}

export class EventService {
  constructor(private deps: ServiceDeps) {}

  private get repo(): EventRepository {
    return this.deps.repositories.events;
  }

  async create(actor: ActorContext, command: CreateEventCommand): Promise<Event> {
    const event = createEvent({
      id: this.deps.config.ids(),
      organizationId: actor.organizationId,
      venueId: command.venueId,
      title: command.title,
      summary: command.summary ?? '',
      description: command.description ?? '',
      startAt: command.startAt,
      endAt: command.endAt ?? null,
      tags: command.tags ?? [],
      now: this.deps.config.clock.now(),
    });
    await this.commit(actor, event, 'event.created', { title: event.title });
    return event;
  }

  async get(actor: ActorContext, eventId: EntityId): Promise<Event> {
    return this.fetchOwned(actor, eventId);
  }

  async list(actor: ActorContext, query: PaginationQuery) {
    return this.repo.listByOrganization(actor.organizationId, query);
  }

  async update(actor: ActorContext, command: UpdateEventCommand): Promise<Event> {
    const event = await this.fetchOwned(actor, command.eventId);
    if (command.expectedVersion !== null && event.version !== command.expectedVersion) {
      throw new VersionConflictError(command.expectedVersion, event.version);
    }
    const updated = updateEvent(event, command.changes, this.deps.config.clock.now());
    await this.commit(actor, updated, 'event.updated', { changed: Object.keys(command.changes) });
    return updated;
  }

  /** Request a review pass: allowed only from `draft`/`review` (FSM-guarded). */
  async review(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, 'review', this.deps.config.clock.now());
    await this.commit(actor, updated, 'event.updated', { status: updated.status });
    return updated;
  }

  /**
   * Publishes only through the FSM (draft→review→scheduled→published).
   *
   * The transition table has no direct `review → published` edge, and no route
   * or service reaches `scheduled` on its own — so a reviewed event would be
   * permanently unpublishable. Publishing therefore walks the legal path one
   * validated edge at a time rather than widening the table. `draft` is
   * deliberately NOT a publishable source: review is not skippable.
   */
  async publish(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const now = this.deps.config.clock.now();
    const scheduled = event.status === 'review' ? transitionEvent(event, 'scheduled', now) : event;
    const updated = transitionEvent(scheduled, 'published', now);
    await this.commit(actor, updated, 'event.published', { status: updated.status });
    return updated;
  }

  async pauseSales(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, 'sales_paused', this.deps.config.clock.now());
    await this.commit(actor, updated, 'event.updated', { status: updated.status });
    return updated;
  }

  async resumeSales(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, 'published', this.deps.config.clock.now());
    await this.commit(actor, updated, 'event.updated', { status: updated.status });
    return updated;
  }

  async cancel(actor: ActorContext, eventId: EntityId, reason: string): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = cancelEvent(event, reason, this.deps.config.clock.now());
    await this.commit(actor, updated, 'event.cancelled', { reason });
    return updated;
  }

  async duplicate(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const source = await this.fetchOwned(actor, eventId);
    if (!source.venueId) throw new EventNotFoundError(eventId);
    const copy = createEvent({
      id: this.deps.config.ids(),
      organizationId: actor.organizationId,
      venueId: source.venueId,
      title: source.title,
      summary: source.summary,
      description: source.description,
      startAt: source.startAt,
      endAt: source.endAt,
      tags: source.tags,
      now: this.deps.config.clock.now(),
    });
    await this.commit(actor, copy, 'event.created', { duplicatedFrom: source.id });
    return copy;
  }

  /** Preview: the event plus its public visibility flag (cached surface). */
  async getPreview(eventId: EntityId): Promise<{ event: Event; isPublic: boolean }> {
    const event = await this.repo.getById(eventId);
    if (!event) throw new EventNotFoundError(eventId);
    return { event, isPublic: isPublicStatus(event.status) };
  }

  /** Direct status transition used by idempotent flows (validate-then-transition). */
  async transitionTo(actor: ActorContext, eventId: EntityId, to: EventStatus): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, to, this.deps.config.clock.now());
    await this.commit(actor, updated, 'event.updated', { status: updated.status });
    return updated;
  }

  /**
   * Persists the aggregate and its domain event in ONE unit of work (T11).
   * If either half fails the whole scope is discarded, so an event can never
   * describe a write that did not land, nor a write go unannounced.
   */
  private async commit(
    actor: ActorContext,
    event: Event,
    type: DomainEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.unitOfWork.runInTransaction(async (tx) => {
      await this.repo.save(event, tx);
      await this.deps.outbox.append(
        newDomainEvent({
          id: this.deps.config.ids(),
          type,
          aggregateId: event.id,
          organizationId: event.organizationId,
          actorId: actor.userId,
          occurredAt: this.deps.config.clock.now(),
          payload,
        }),
        tx,
      );
    });
  }

  private async fetchOwned(actor: ActorContext, eventId: EntityId): Promise<Event> {
    requireOrgAccess(actor, actor.organizationId);
    const event = await this.repo.getById(eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      // Ownership check doubles as the IDOR guard (host event access).
      throw new EventNotFoundError(eventId);
    }
    return event;
  }
}
