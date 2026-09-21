import {
  EventNotFoundError,
  VersionConflictError,
  InvalidOperationError,
} from '../../domain/errors.js';
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

/** Poster upload cap — mirrors the KYC image budget (5 MB). */
const MAX_POSTER_BYTES = 5 * 1024 * 1024;
/** Signed upload URL time-to-live — the client PUT must happen soon after mint. */
const POSTER_UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
const ALLOWED_POSTER_CONTENT_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface IssuePosterUploadUrlCommand {
  contentType: string;
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

  /**
   * Mints a short-lived, content-type-bound, size-bound URL the partner `PUT`s
   * an event poster straight to — the gateway never sees the bytes. The caller
   * stores the returned `publicUrl` as the event's `imageUrl` on create.
   *
   * Not idempotency-keyed: minting a fresh URL is safe to repeat, and every
   * mint gets a fresh object key (`posters/<org>/<uuid>.<ext>`), so a re-upload
   * never clobbers an existing poster.
   */
  async issuePosterUploadUrl(
    actor: ActorContext,
    command: IssuePosterUploadUrlCommand,
  ): Promise<{
    uploadUrl: string;
    method: 'PUT';
    headers: Readonly<Record<string, string>>;
    storagePath: string;
    publicUrl: string;
    expiresAt: number;
  }> {
    requireOrgAccess(actor, actor.organizationId);
    if (!ALLOWED_POSTER_CONTENT_TYPES.includes(command.contentType)) {
      throw new InvalidOperationError('Poster must be a JPEG, PNG, or WebP image');
    }
    const extension = CONTENT_TYPE_EXTENSION[command.contentType];
    const key = `posters/${actor.organizationId}/${this.deps.config.ids()}.${extension}`;
    const expiresAt = this.deps.config.clock.now().getTime() + POSTER_UPLOAD_URL_TTL_MS;
    const grant = await this.deps.objectStorage.issueUploadUrl({
      key,
      contentType: command.contentType,
      maxBytes: MAX_POSTER_BYTES,
      expiresAt,
      // Posters must render on the guest surface with no credential, so the
      // signed PUT sets the object ACL to public-read. KYC stays private by
      // default — see object-storage port.
      visibility: 'public',
    });
    this.deps.logger.info('events.poster_upload_url_issued', {
      organizationId: actor.organizationId,
      provider: this.deps.objectStorage.name,
    });
    return {
      ...grant,
      publicUrl: this.deps.objectStorage.toPublicUrl(grant.storagePath),
    };
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

  /**
   * Publishes through the FSM (draft→review→scheduled→published).
   *
   * `EVENT_TRANSITIONS` has no direct `review → published` edge, and nothing
   * else in this slice reaches `scheduled` — so without this, a reviewed
   * event was permanently unpublishable. `publish()` walks the legal path
   * one validated edge at a time instead of widening the transition table;
   * `draft → published` stays illegal (review is not skippable) because the
   * `scheduled` step only runs from `review`.
   */
  async publish(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const now = this.deps.config.clock.now();
    // The `scheduled` step is transient: only the final `published` state is
    // persisted, so the version bump happens once. Walking two live bumps
    // (review→scheduled→published) and saving only the last would write
    // version N+2 against a store at version N — rejected by the repository
    // compare-and-set on every driver.
    const scheduled =
      event.status === 'review' ? { ...event, status: 'scheduled' as const } : event;
    const updated = transitionEvent(scheduled, 'published', now);
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
