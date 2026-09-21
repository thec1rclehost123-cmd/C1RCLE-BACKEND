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
  type EventCompensation,
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
  compensation?: EventCompensation | null;
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
    compensation?: EventCompensation | null;
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
    await this.assertVenueAccess(actor, command.venueId);
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
      compensation: command.compensation ?? null,
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
    const tiers = await this.deps.repositories.catalog.listTiers(event.id);
    validateCompensationForPublish(
      event.compensation ?? null,
      tiers.map((tier) => tier.id),
    );
    const now = this.deps.config.clock.now();
    // Ticket pricing is the source of truth. The create endpoint cannot know
    // the final catalog yet, so refresh these denormalized discovery fields at
    // the publish boundary before the event becomes guest-visible.
    const startingPricePaise = tiers.length
      ? Math.min(...tiers.map((tier) => tier.priceInPaise))
      : 0;
    const isFree = tiers.length === 0 || tiers.every((tier) => tier.priceInPaise === 0);
    const withCatalogSummary = { ...event, startingPricePaise, isFree };
    // The `scheduled` step is transient: only the final `published` state is
    // persisted, so the version bump happens once. Walking two live bumps
    // (review→scheduled→published) and saving only the last would write
    // version N+2 against a store at version N — rejected by the repository
    // compare-and-set on every driver.
    const scheduled =
      withCatalogSummary.status === 'review'
        ? { ...withCatalogSummary, status: 'scheduled' as const }
        : withCatalogSummary;
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

  /**
   * A venue event may be created by its owner or by a host with an active
   * venue partnership. Keep the missing-resource response deliberately
   * indistinguishable from an inaccessible venue to avoid an IDOR oracle.
   *
   * Some legacy callers create a draft before the venue aggregate is seeded;
   * those drafts are preserved for backwards compatibility. Once a venue is
   * present, cross-tenant and suspended-venue writes are rejected here.
   */
  private async assertVenueAccess(actor: ActorContext, venueId: EntityId): Promise<void> {
    const venue = await this.deps.repositories.venues.getById(venueId);
    if (!venue) return;
    if (venue.status !== 'active') throw new EventNotFoundError(venueId);
    if (venue.organizationId === actor.organizationId) return;
    const partnership = await this.deps.repositories.partnerships.findByPair(
      actor.organizationId,
      venueId,
    );
    if (partnership?.status !== 'active') throw new EventNotFoundError(venueId);
  }
}

function validateCompensationForPublish(
  compensation: EventCompensation | null,
  tierIds: readonly string[],
): void {
  if (!compensation) return;
  if (compensation.model === 'standard') {
    if (
      compensation.globalRatePercent === null ||
      compensation.globalRatePercent < 0 ||
      compensation.globalRatePercent > 100
    ) {
      throw new InvalidOperationError('Global commission must be between 0 and 100 percent');
    }
    return;
  }
  if (compensation.model === 'salary') {
    if (
      compensation.salaryAmountPaise === null ||
      !Number.isInteger(compensation.salaryAmountPaise) ||
      compensation.salaryAmountPaise <= 0
    ) {
      throw new InvalidOperationError('Salary amount must be greater than zero');
    }
    if (compensation.salaryPeriod === null) {
      throw new InvalidOperationError('Salary period is required');
    }
    return;
  }
  for (const tierId of tierIds) {
    const rate = compensation.tierRates[tierId];
    if (rate === undefined)
      throw new InvalidOperationError('Every ticket tier needs a commission before publishing');
    if (!Number.isInteger(rate) || rate < 0 || rate > 100)
      throw new InvalidOperationError(
        'Ticket commissions must be whole numbers between 0 and 100 percent',
      );
  }
}
