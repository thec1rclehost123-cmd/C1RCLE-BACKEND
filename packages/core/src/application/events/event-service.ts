import { EventNotFoundError, VersionConflictError } from '../../domain/errors.js';
import {
  createEvent,
  transitionEvent,
  cancelEvent,
  updateEvent,
  isPublicStatus,
  type EventStatus,
  type Event,
} from '../../domain/models/event.js';
import { requireOrgAccess, emit } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { EventRepository, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateEventCommand {
  venueId: EntityId;
  title: string;
  summary?: string;
  description?: string;
  imageUrl?: string | null;
  startAt: string;
  endAt?: string | null;
  tags?: string[];
}

export interface UpdateEventCommand {
  eventId: EntityId;
  expectedVersion: number | null;
  changes: {
    slug?: string;
    title?: string;
    summary?: string;
    description?: string;
    imageUrl?: string | null;
    startAt?: string;
    endAt?: string | null;
    tags?: string[];
    startingPricePaise?: number;
    isFree?: boolean;
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
      imageUrl: command.imageUrl ?? null,
      startAt: command.startAt,
      endAt: command.endAt ?? null,
      tags: command.tags ?? [],
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(event);
    await emit(this.deps, actor, event.id, 'event.created', {
      title: event.title,
      venueId: event.venueId ?? '',
    });
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
    if (updated === event) return event;
    await this.repo.save(updated);
    await emit(this.deps, actor, updated.id, 'event.updated', {
      title: updated.title,
    });
    return updated;
  }

  /** Request a review pass: allowed only from `draft`/`review` (FSM-guarded). */
  async review(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, 'review', this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }

  /** Publishes only through the FSM (draft→review→scheduled→published). */
  async publish(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, 'published', this.deps.config.clock.now());
    await this.repo.save(updated);
    await emit(this.deps, actor, updated.id, 'event.published', {
      title: updated.title,
    });
    return updated;
  }

  async pauseSales(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, 'sales_paused', this.deps.config.clock.now());
    await this.repo.save(updated);
    await emit(this.deps, actor, updated.id, 'event.updated', {
      title: updated.title,
    });
    return updated;
  }

  async resumeSales(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, 'published', this.deps.config.clock.now());
    await this.repo.save(updated);
    await emit(this.deps, actor, updated.id, 'event.published', {
      title: updated.title,
    });
    return updated;
  }

  async cancel(actor: ActorContext, eventId: EntityId, reason: string): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = cancelEvent(event, reason, this.deps.config.clock.now());
    await this.repo.save(updated);
    await emit(this.deps, actor, updated.id, 'event.cancelled', {
      title: updated.title,
    });
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
      imageUrl: source.imageUrl,
      startAt: source.startAt,
      endAt: source.endAt,
      tags: source.tags,
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(copy);
    await emit(this.deps, actor, copy.id, 'event.created', {
      title: copy.title,
      venueId: copy.venueId ?? '',
    });
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
    await this.repo.save(updated);
    return updated;
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
