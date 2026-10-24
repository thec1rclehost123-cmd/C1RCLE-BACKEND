import {
  EventNotFoundError,
  VersionConflictError,
  InvalidOperationError,
} from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
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
import type { SlotRequest } from '../../domain/models/venue.js';
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
  slotRequestId?: EntityId | null;
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
    const isHost = actor.capabilities.includes('host');
    let acceptedRequest: SlotRequest | null = null;
    if (isHost) {
      if (!command.slotRequestId) {
        throw new InvalidOperationError(
          'Hosts must create events from an accepted Venue slot request',
        );
      }
      acceptedRequest = await this.deps.repositories.slotRequests.getById(command.slotRequestId);
      if (
        !acceptedRequest ||
        acceptedRequest.hostId !== actor.organizationId ||
        acceptedRequest.venueId !== command.venueId ||
        acceptedRequest.status !== 'accepted' ||
        !acceptedRequest.slotId
      ) {
        throw new InvalidOperationError(
          'The accepted Venue slot request is unavailable for this Host',
        );
      }
      const slot = await this.deps.repositories.venueSlots.getSlotById(acceptedRequest.slotId);
      const start = Date.parse(command.startAt);
      const end = command.endAt ? Date.parse(command.endAt) : NaN;
      if (
        !slot ||
        slot.status !== 'booked' ||
        slot.slotRequestId !== acceptedRequest.id ||
        slot.requestingHostId !== actor.organizationId ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < Date.parse(slot.startTime) ||
        end > Date.parse(slot.endTime) ||
        end <= start
      ) {
        throw new InvalidOperationError(
          'Event date and time must fit within the accepted Venue slot',
        );
      }
      if (acceptedRequest.eventId) {
        const existingEvent = await this.repo.getById(acceptedRequest.eventId);
        if (existingEvent) {
          const sameCreateCommand =
            existingEvent.organizationId === actor.organizationId &&
            existingEvent.venueId === command.venueId &&
            existingEvent.title === command.title &&
            existingEvent.summary === (command.summary ?? '') &&
            existingEvent.description === (command.description ?? '') &&
            existingEvent.imageUrl === (command.imageUrl ?? null) &&
            existingEvent.startAt === command.startAt &&
            existingEvent.endAt === (command.endAt ?? null) &&
            JSON.stringify(existingEvent.tags) === JSON.stringify(command.tags ?? []) &&
            JSON.stringify(existingEvent.compensation) ===
              JSON.stringify(command.compensation ?? null);
          if (sameCreateCommand) return existingEvent;
          throw new InvalidOperationError(
            'The accepted Venue slot request is unavailable for this Host',
          );
        }
        // A prior create may have claimed the request then failed before the
        // event save. Reuse its ID below so the accepted reservation can recover.
      }
      const overlappingEvents = await this.repo.listByVenue(command.venueId, {
        cursor: null,
        limit: 1000,
      });
      if (
        overlappingEvents.items.some(
          (event) =>
            event.status !== 'cancelled' &&
            event.endAt &&
            start < Date.parse(event.endAt) &&
            end > Date.parse(event.startAt),
        )
      ) {
        throw new InvalidOperationError('The accepted Venue slot conflicts with another event');
      }
    } else if (command.slotRequestId) {
      throw new InvalidOperationError('Only a Host can create an event from a Host slot request');
    }
    if (command.endAt) {
      const overlappingSlots = await this.deps.repositories.venueSlots.listOverlappingSlots(
        command.venueId,
        command.startAt,
        command.endAt,
      );
      const conflictingSlot = overlappingSlots.find(
        (slot) => slot.status !== 'cancelled' && slot.id !== acceptedRequest?.slotId,
      );
      if (conflictingSlot) {
        throw new InvalidOperationError('The event conflicts with a Venue calendar slot');
      }
    }
    const event = createEvent({
      id: acceptedRequest?.eventId ?? this.deps.config.ids(),
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
    if (acceptedRequest) {
      await this.deps.repositories.slotRequests.claimAcceptedSlotEvent(
        acceptedRequest.id,
        actor.organizationId,
        event.id,
      );
    }
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

  /** Bounded tenant-scoped operations view for the partner event list. */
  async listWithOperations(actor: ActorContext, query: PaginationQuery) {
    requireOrgAccess(actor, actor.organizationId);
    const page = await this.repo.listByOrganization(actor.organizationId, query);
    const [orders, venues] = await Promise.all([
      this.deps.repositories.orders.listByOrganization(actor.organizationId, {
        cursor: null,
        limit: 1000,
      }),
      this.deps.repositories.venues.getByIds([
        ...new Set(page.items.flatMap((event) => (event.venueId ? [event.venueId] : []))),
      ]),
    ]);
    const soldByEvent = new Map<EntityId, number>();
    for (const order of orders.items) {
      if (!['paid', 'refund_requested', 'refunded'].includes(order.status)) continue;
      soldByEvent.set(
        order.eventId,
        (soldByEvent.get(order.eventId) ?? 0) +
          order.lines.reduce((sum, line) => sum + line.quantity, 0),
      );
    }
    const venueNames = new Map(venues.map((venue) => [venue.id, venue.public.name]));
    const salesCountComplete = orders.nextCursor === null;
    return {
      ...page,
      items: page.items.map((event) => ({
        event,
        capacity: event.capacity,
        venueName: event.venueId ? (venueNames.get(event.venueId) ?? null) : null,
        ticketsSold: soldByEvent.get(event.id) ?? 0,
        salesCountComplete,
      })),
    };
  }

  /** Tenant-scoped event detail with the same bounded sales evidence as the list. */
  async getWithOperations(actor: ActorContext, eventId: EntityId) {
    const event = await this.fetchOwned(actor, eventId);
    const [orders, venues] = await Promise.all([
      this.deps.repositories.orders.listByOrganization(actor.organizationId, {
        cursor: null,
        limit: 1000,
      }),
      event.venueId ? this.deps.repositories.venues.getByIds([event.venueId]) : Promise.resolve([]),
    ]);
    const ticketsSold = orders.items
      .filter(
        (order) =>
          order.eventId === event.id &&
          ['paid', 'refund_requested', 'refunded'].includes(order.status),
      )
      .reduce(
        (total, order) => total + order.lines.reduce((sum, line) => sum + line.quantity, 0),
        0,
      );
    return {
      event,
      capacity: event.capacity,
      venueName: venues[0]?.public.name ?? null,
      ticketsSold,
      salesCountComplete: orders.nextCursor === null,
    };
  }

  async update(actor: ActorContext, command: UpdateEventCommand): Promise<Event> {
    const event = await this.fetchOwned(actor, command.eventId);
    if (command.expectedVersion !== null && event.version !== command.expectedVersion) {
      throw new VersionConflictError(command.expectedVersion, event.version);
    }
    const updated = updateEvent(event, command.changes, this.deps.config.clock.now());
    if (updated === event) return event;
    await this.repo.save(updated);
    const materialChange =
      event.title !== updated.title || event.startAt !== updated.startAt
        ? {
            eventVersion: updated.version,
            previousTitle: event.title,
            title: updated.title,
            previousStartAt: event.startAt,
            startAt: updated.startAt,
          }
        : null;
    await emit(this.deps, actor, updated.id, 'event.updated', {
      title: updated.title,
      materialChange,
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
      tiers
        .filter((tier) => tier.accessType !== 'RSVP' && tier.commissionEligible !== false)
        .map((tier) => tier.id),
    );
    const now = this.deps.config.clock.now();
    // Ticket pricing is the source of truth. The create endpoint cannot know
    // the final catalog yet, so refresh these denormalized discovery fields at
    // the publish boundary before the event becomes guest-visible.
    const paidTiers = tiers.filter((tier) => tier.accessType !== 'RSVP');
    const startingPricePaise = paidTiers.length
      ? Math.min(...paidTiers.map((tier) => tier.priceInPaise))
      : 0;
    // Respect an explicit isFree: false set by the host via PATCH — only
    // auto-derive from tiers when the event hasn't been explicitly marked paid.
    const isFree = !event.isFree
      ? false
      : paidTiers.length === 0 || paidTiers.every((tier) => tier.priceInPaise === 0);
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
    if (updated !== event) await this.repo.save(updated);
    // Stable identity turns a retry into an outbox repair if the process died
    // after the event CAS but before enqueueing downstream cancellation work.
    await this.deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId('event.cancelled', updated.id, String(updated.version)),
        type: 'event.cancelled',
        aggregateId: updated.id,
        organizationId: updated.organizationId,
        actorId: actor.userId,
        payload: {
          title: updated.title,
          reason: updated.cancellationReason ?? reason,
          eventVersion: updated.version,
        },
        occurredAt: this.deps.config.clock.now().getTime(),
      }),
    );
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
