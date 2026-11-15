import {
  ForbiddenError,
  EventNotFoundError,
  VersionConflictError,
  InvalidOperationError,
} from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { isMaterialEventChange } from '../../domain/models/event-policy.js';
import {
  createEvent,
  transitionEvent,
  transitionEventStatus,
  postponeEvent,
  cancelEvent,
  resubmitExternalLocation,
  updateEvent,
  type EventStatus,
  type Event,
  type EventCompensation,
  type EventAddressDisclosure,
  type EventEntryRules,
  type EventMedia,
  type EventVisibilityMode,
} from '../../domain/models/event.js';
import { transitionSlotRequest } from '../../domain/models/venue.js';
import { requireOrgAccess, emit } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { SlotRequest } from '../../domain/models/venue.js';
import type { EventRepository, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateEventCommand {
  venueId: EntityId | null;
  externalLocation?: Omit<NonNullable<Event['externalLocation']>, 'review'>;
  title: string;
  summary?: string;
  description?: string;
  imageUrl?: string | null;
  startAt: string;
  endAt?: string | null;
  tags?: string[];
  refundPolicy?: Event['refundPolicy'];
  compensation?: EventCompensation | null;
  visibilityMode?: EventVisibilityMode;
  addressDisclosure?: EventAddressDisclosure;
  entryRules?: EventEntryRules;
  media?: EventMedia;
  slotRequestId?: EntityId | null;
}

export interface UpdateEventCommand {
  /** Internal command flag; only the explicit reschedule endpoint sets this. */
  resumePostponed?: boolean;
  eventId: EntityId;
  expectedVersion: number | null;
  changes: {
    venueId?: EntityId;
    slotRequestId?: EntityId;
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
    refundPolicy?: Event['refundPolicy'];
    compensation?: EventCompensation | null;
    visibilityMode?: EventVisibilityMode;
    addressDisclosure?: EventAddressDisclosure;
    entryRules?: EventEntryRules;
    media?: EventMedia;
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
    const visibilityMode = command.visibilityMode ?? 'public';
    if (
      (visibilityMode === 'code' || visibilityMode === 'invited') &&
      this.deps.config.features.m5PrivateAccess !== true
    ) {
      throw new InvalidOperationError('Private event access is not enabled for this deployment');
    }
    if (
      command.addressDisclosure === 'after_grant' &&
      visibilityMode !== 'code' &&
      visibilityMode !== 'invited'
    ) {
      throw new InvalidOperationError('After-grant address disclosure requires a private event');
    }
    const isHost = actor.capabilities.includes('host');
    const externalLocation = command.externalLocation;
    if (externalLocation) {
      if (!isHost || command.venueId !== null || command.slotRequestId) {
        throw new InvalidOperationError(
          'External event locations are available to Hosts without Venue slots',
        );
      }
    } else {
      if (!command.venueId) throw new InvalidOperationError('Choose a Venue');
      await this.assertVenueAccess(actor, command.venueId);
    }
    let acceptedRequest: SlotRequest | null = null;
    if (isHost && !externalLocation) {
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
            (existingEvent.visibilityMode ?? 'public') === (command.visibilityMode ?? 'public') &&
            (existingEvent.addressDisclosure ??
              (existingEvent.visibilityMode === 'code' || existingEvent.visibilityMode === 'invited'
                ? 'hidden'
                : 'public')) ===
              (command.addressDisclosure ??
                (command.visibilityMode === 'code' || command.visibilityMode === 'invited'
                  ? 'hidden'
                  : 'public')) &&
            existingEvent.startAt === command.startAt &&
            existingEvent.endAt === (command.endAt ?? null) &&
            JSON.stringify(existingEvent.tags) === JSON.stringify(command.tags ?? []) &&
            JSON.stringify(existingEvent.compensation) ===
              JSON.stringify(command.compensation ?? null) &&
            JSON.stringify(existingEvent.entryRules) === JSON.stringify(command.entryRules) &&
            JSON.stringify(existingEvent.media) === JSON.stringify(command.media) &&
            JSON.stringify(existingEvent.refundPolicy ?? { kind: 'organizer_reviewed' }) ===
              JSON.stringify(command.refundPolicy ?? { kind: 'organizer_reviewed' });
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
    } else if (!isHost && command.slotRequestId) {
      throw new InvalidOperationError('Only a Host can create an event from a Host slot request');
    }
    if (command.endAt && command.venueId) {
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
    const privateVisibility = visibilityMode === 'code' || visibilityMode === 'invited';
    const posterUrl = command.imageUrl ?? null;
    const privateImageStoragePath = privateVisibility
      ? await this.revokePrivatePoster(posterUrl, actor.organizationId)
      : null;
    const now = this.deps.config.clock.now();
    const event = createEvent({
      id: acceptedRequest?.eventId ?? this.deps.config.ids(),
      organizationId: actor.organizationId,
      venueId: command.venueId,
      ...(externalLocation
        ? {
            externalLocation: {
              ...externalLocation,
              review: {
                status: 'pending' as const,
                submittedAt: now.toISOString(),
                reviewedAt: null,
                reviewedBy: null,
                rejectionReason: null,
              },
            },
          }
        : {}),
      title: command.title,
      summary: command.summary ?? '',
      description: command.description ?? '',
      imageUrl: privateVisibility ? null : posterUrl,
      privateImageStoragePath,
      startAt: command.startAt,
      endAt: command.endAt ?? null,
      visibilityMode: command.visibilityMode ?? 'public',
      addressDisclosure: command.addressDisclosure,
      entryRules: command.entryRules,
      media: command.media,
      tags: command.tags ?? [],
      refundPolicy: command.refundPolicy,
      compensation: command.compensation ?? null,
      now,
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

  /** Venue view: list events assigned to the Venue's own records, while
   * preserving the Host as the event owner. */
  async listForVenueOrganization(actor: ActorContext, query: PaginationQuery) {
    requireOrgAccess(actor, actor.organizationId);
    if (!actor.capabilities.includes('venue')) {
      throw new ForbiddenError('Venue access is required to list Venue events');
    }
    const venuePage = await this.deps.repositories.venues.listByOrganization(actor.organizationId, {
      cursor: null,
      limit: 100,
    });
    const venueIds = new Set(venuePage.items.map((venue) => venue.id));
    const allEvents: Event[] = [];
    for (const venueId of venueIds) {
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await this.repo.listByVenue(venueId, { cursor, limit: 100 });
        allEvents.push(...page.items);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
    }
    const uniqueEvents = [...new Map(allEvents.map((event) => [event.id, event])).values()]
      .filter((event) => event.venueId !== null && venueIds.has(event.venueId))
      .sort(
        (left, right) =>
          left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id),
      );
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const events = uniqueEvents.slice(offset, offset + limit);
    const ownerIds = [...new Set(events.map((event) => event.organizationId))];
    const ownerOrders = await Promise.all(
      ownerIds.map(async (ownerId) => ({
        ownerId,
        page: await this.deps.repositories.orders.listByOrganization(ownerId, {
          cursor: null,
          limit: 1000,
        }),
      })),
    );
    const soldByEvent = new Map<EntityId, number>();
    for (const { page } of ownerOrders) {
      for (const order of page.items) {
        if (!['paid', 'refund_requested', 'refunded'].includes(order.status)) continue;
        soldByEvent.set(
          order.eventId,
          (soldByEvent.get(order.eventId) ?? 0) +
            order.lines.reduce((sum, line) => sum + line.quantity, 0),
        );
      }
    }
    const venuePageById = new Map(venuePage.items.map((venue) => [venue.id, venue]));
    return {
      total: uniqueEvents.length,
      nextCursor:
        offset + events.length < uniqueEvents.length ? String(offset + events.length) : null,
      items: events.map((event) => ({
        event,
        capacity: event.capacity,
        venueName: event.venueId ? (venuePageById.get(event.venueId)?.public.name ?? null) : null,
        ticketsSold: soldByEvent.get(event.id) ?? 0,
        salesCountComplete: ownerOrders.every(({ page }) => page.nextCursor === null),
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
    const { slotRequestId, ...requestedChanges } = command.changes;
    const nextVisibilityMode = command.changes.visibilityMode ?? event.visibilityMode ?? 'public';
    const nextAddressDisclosure = command.changes.addressDisclosure ?? event.addressDisclosure;
    if (
      (nextVisibilityMode === 'code' || nextVisibilityMode === 'invited') &&
      this.deps.config.features.m5PrivateAccess !== true
    ) {
      throw new InvalidOperationError('Private event access is not enabled for this deployment');
    }
    if (
      nextAddressDisclosure === 'after_grant' &&
      nextVisibilityMode !== 'code' &&
      nextVisibilityMode !== 'invited'
    ) {
      throw new InvalidOperationError('After-grant address disclosure requires a private event');
    }
    if (command.expectedVersion !== null && event.version !== command.expectedVersion) {
      throw new VersionConflictError(command.expectedVersion, event.version);
    }
    const nextStartAt = command.changes.startAt ?? event.startAt;
    const nextEndAt = Object.hasOwn(command.changes, 'endAt')
      ? (command.changes.endAt ?? null)
      : event.endAt;
    if (
      !actor.capabilities.includes('host') &&
      (command.changes.startAt !== undefined || Object.hasOwn(command.changes, 'endAt')) &&
      (!Number.isFinite(Date.parse(nextStartAt)) ||
        (nextEndAt !== null &&
          (!Number.isFinite(Date.parse(nextEndAt)) ||
            Date.parse(nextEndAt) <= Date.parse(nextStartAt))))
    ) {
      throw new InvalidOperationError('Event end must be after a valid event start');
    }
    const nextVenueId = requestedChanges.venueId ?? event.venueId;
    const scheduleChange =
      nextStartAt !== event.startAt ||
      nextEndAt !== event.endAt ||
      nextVenueId !== event.venueId ||
      slotRequestId !== undefined;
    let approvedRequest: SlotRequest | null = null;
    if (actor.capabilities.includes('host') && scheduleChange) {
      if (event.externalLocation) {
        if (slotRequestId !== undefined || nextVenueId !== null)
          throw new InvalidOperationError('External-location events cannot use Venue slots');
        if (
          !Number.isFinite(Date.parse(nextStartAt)) ||
          (nextEndAt !== null &&
            (!Number.isFinite(Date.parse(nextEndAt)) ||
              Date.parse(nextEndAt) <= Date.parse(nextStartAt)))
        )
          throw new InvalidOperationError('Event end must be after a valid event start');
      } else {
        approvedRequest = await this.assertHostRescheduleFitsAcceptedSlot(
          actor,
          event,
          nextStartAt,
          nextEndAt,
          nextVenueId,
          slotRequestId,
        );
        requestedChanges.venueId = approvedRequest.venueId;
      }
    } else if (slotRequestId !== undefined || nextVenueId !== event.venueId) {
      throw new InvalidOperationError('Only a Host can apply a Venue-approved slot request');
    }
    const isPrivate = nextVisibilityMode === 'code' || nextVisibilityMode === 'invited';
    const imageChanged = Object.hasOwn(command.changes, 'imageUrl');
    const nextImageUrl = imageChanged ? (command.changes.imageUrl ?? null) : event.imageUrl;
    const privateImageStoragePath = isPrivate
      ? imageChanged
        ? await this.revokePrivatePoster(nextImageUrl, actor.organizationId)
        : (event.privateImageStoragePath ??
          (await this.revokePrivatePoster(event.imageUrl, actor.organizationId)))
      : null;
    const changes = isPrivate
      ? {
          ...requestedChanges,
          imageUrl: null,
          privateImageStoragePath,
        }
      : { ...requestedChanges, privateImageStoragePath: null };
    if (command.resumePostponed) {
      if (
        event.status !== 'postponed' ||
        !command.changes.startAt ||
        Date.parse(nextStartAt) <= this.deps.config.clock.now().getTime()
      ) {
        throw new InvalidOperationError(
          'Rescheduling requires a postponed event and a future replacement date',
        );
      }
      transitionEventStatus(event.status, 'published');
    }
    const changed = updateEvent(event, changes, this.deps.config.clock.now());
    let updated = command.resumePostponed
      ? { ...changed, status: 'published' as const, isPublic: nextVisibilityMode === 'public' }
      : changed;
    if (updated === event) return event;
    const materialChange =
      command.resumePostponed || isMaterialEventChange(event, updated)
        ? {
            eventVersion: updated.version,
            previousTitle: event.title,
            title: updated.title,
            previousStartAt: event.startAt,
            startAt: updated.startAt,
            previousVenueId: event.venueId,
            venueId: updated.venueId,
            ...(command.resumePostponed ? { changeType: 'rescheduled' as const } : {}),
          }
        : null;
    if (materialChange)
      updated = { ...updated, lastMaterialChangeAt: this.deps.config.clock.now().toISOString() };
    const outboxEvent = domainEvent({
      id: deterministicDomainEventId('event.updated', updated.id, String(updated.version)),
      type: 'event.updated',
      aggregateId: updated.id,
      organizationId: updated.organizationId,
      actorId: actor.userId,
      payload: { title: updated.title, materialChange },
      occurredAt: this.deps.config.clock.now().getTime(),
    });
    await this.repo.save(updated, null, outboxEvent);
    if (approvedRequest)
      await this.releaseSupersededEventSlots(actor, event.id, approvedRequest.id);
    await this.deps.outbox.append(outboxEvent);
    return updated;
  }

  /** Request a review pass: allowed only from `draft`/`review` (FSM-guarded). */
  async review(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    if (event.externalLocation && event.externalLocation.review.status !== 'approved')
      throw new InvalidOperationError(
        'C1RCLE must approve the external venue before this event can enter publication review',
      );
    const updated = transitionEvent(event, 'review', this.deps.config.clock.now());
    if (updated === event) return event;
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
    if (event.externalLocation && event.externalLocation.review.status !== 'approved')
      throw new InvalidOperationError(
        'C1RCLE must approve the external venue before this event can be published',
      );
    this.assertPrivateAccessEnabled(event);
    if (event.status === 'postponed')
      throw new InvalidOperationError(
        'Announce a replacement date before resuming a postponed event',
      );
    if (event.status !== 'review' && event.status !== 'scheduled') {
      return transitionEvent(event, 'published', this.deps.config.clock.now());
    }
    if (!event.summary.trim() || !event.description.trim()) {
      throw new InvalidOperationError(
        'Add a guest-facing summary and description before publishing',
      );
    }
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
    const isPrivate = event.visibilityMode === 'code' || event.visibilityMode === 'invited';
    const privateImageStoragePath = isPrivate
      ? ((await this.revokePrivatePoster(event.imageUrl, actor.organizationId)) ??
        event.privateImageStoragePath ??
        null)
      : null;
    const withCatalogSummary = {
      ...event,
      startingPricePaise,
      isFree,
      imageUrl: isPrivate ? null : event.imageUrl,
      privateImageStoragePath,
    };
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

  async resubmitExternalLocation(
    actor: ActorContext,
    eventId: EntityId,
    submission: Omit<NonNullable<Event['externalLocation']>, 'review'>,
  ): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    if (!actor.capabilities.includes('host'))
      throw new InvalidOperationError('Only the Host can resubmit an external venue request');
    const updated = resubmitExternalLocation(event, submission, this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }

  async pauseSales(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = transitionEvent(event, 'sales_paused', this.deps.config.clock.now());
    if (updated === event) return event;
    await this.repo.save(updated);
    await emit(this.deps, actor, updated.id, 'event.updated', {
      title: updated.title,
    });
    return updated;
  }

  async resumeSales(actor: ActorContext, eventId: EntityId): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    if (event.externalLocation && event.externalLocation.review.status !== 'approved')
      throw new InvalidOperationError(
        'C1RCLE must approve the external venue before sales can resume',
      );
    this.assertPrivateAccessEnabled(event);
    if (event.status === 'postponed')
      throw new InvalidOperationError(
        'Announce a replacement date before resuming a postponed event',
      );
    const updated = transitionEvent(event, 'published', this.deps.config.clock.now());
    if (updated === event) return event;
    await this.repo.save(updated);
    await emit(this.deps, actor, updated.id, 'event.published', {
      title: updated.title,
    });
    return updated;
  }

  async postpone(actor: ActorContext, eventId: EntityId, reason: string): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = postponeEvent(
      event,
      reason,
      'host',
      actor.organizationId,
      this.deps.config.clock.now(),
    );
    // Deterministic replay closes a failure between persistence and enqueueing.
    const outboxEvent = domainEvent({
      id: deterministicDomainEventId('event.postponed', updated.id, String(updated.version)),
      type: 'event.updated',
      aggregateId: updated.id,
      organizationId: updated.organizationId,
      actorId: actor.userId,
      payload: {
        title: updated.title,
        materialChange: {
          eventVersion: updated.version,
          previousTitle: event.title,
          title: updated.title,
          previousStartAt: event.startAt,
          startAt: updated.startAt,
          previousVenueId: event.venueId,
          venueId: updated.venueId,
          changeType: 'postponed',
        },
      },
      occurredAt: this.deps.config.clock.now().getTime(),
    });
    if (updated !== event) await this.repo.save(updated, null, outboxEvent);
    await this.deps.outbox.append(outboxEvent);
    return updated;
  }

  async cancel(actor: ActorContext, eventId: EntityId, reason: string): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    const updated = cancelEvent(event, reason, this.deps.config.clock.now());
    const outboxEvent = domainEvent({
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
    });
    if (updated !== event) await this.repo.save(updated, null, outboxEvent);
    await this.deps.outbox.append(outboxEvent);
    return updated;
  }

  private assertPrivateAccessEnabled(event: Event): void {
    if (
      (event.visibilityMode === 'code' || event.visibilityMode === 'invited') &&
      this.deps.config.features.m5PrivateAccess !== true
    ) {
      throw new InvalidOperationError('Private event access is not enabled for this deployment');
    }
  }

  /**
   * A Host may adjust timing only inside the exact Venue-approved slot already
   * attached to this event. A different day/time requires a fresh Venue slot
   * approval; changing the event record alone cannot move that reservation.
   */
  private async assertHostRescheduleFitsAcceptedSlot(
    actor: ActorContext,
    event: Event,
    startAt: string,
    endAt: string | null,
    venueId: EntityId | null,
    preferredRequestId?: EntityId,
  ): Promise<SlotRequest> {
    let cursor: string | null = null;
    const acceptedRequests: SlotRequest[] = [];
    do {
      const page = await this.deps.repositories.slotRequests.listByHost(actor.organizationId, {
        cursor,
        limit: 100,
      });
      acceptedRequests.push(
        ...page.items.filter(
          (request) =>
            request.eventId === event.id &&
            request.status === 'accepted' &&
            (preferredRequestId === undefined || request.id === preferredRequestId),
        ),
      );
      cursor = page.nextCursor;
    } while (cursor !== null);

    if (acceptedRequests.length === 0 || !endAt) {
      throw new InvalidOperationError(
        'A Host reschedule requires its active Venue-approved time slot',
      );
    }
    const start = Date.parse(startAt);
    const end = Date.parse(endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new InvalidOperationError(
        'Host event timing must remain within its Venue-approved slot',
      );
    }
    for (const request of acceptedRequests) {
      if (!request.slotId || request.venueId !== venueId || request.hostId !== actor.organizationId)
        continue;
      const slot = await this.deps.repositories.venueSlots.getSlotById(request.slotId);
      if (
        slot &&
        slot.status === 'booked' &&
        slot.slotRequestId === request.id &&
        slot.requestingHostId === actor.organizationId &&
        slot.venueId === request.venueId &&
        start >= Date.parse(slot.startTime) &&
        end <= Date.parse(slot.endTime)
      ) {
        const partnership = await this.deps.repositories.partnerships.findByPair(
          actor.organizationId,
          request.venueId,
        );
        const venue = await this.deps.repositories.venues.getById(request.venueId);
        if (venue?.status === 'active' && partnership?.status === 'active') return request;
      }
    }
    throw new InvalidOperationError(
      preferredRequestId
        ? 'The selected Venue slot request is not an accepted, booked slot for this event'
        : 'Host event timing must remain within its Venue-approved slot',
    );
  }

  /** Release older accepted reservations only after the event points at its new approved slot. */
  private async releaseSupersededEventSlots(
    actor: ActorContext,
    eventId: EntityId,
    currentRequestId: EntityId,
  ): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await this.deps.repositories.slotRequests.listByHost(actor.organizationId, {
        cursor,
        limit: 100,
      });
      for (const request of page.items) {
        if (
          request.eventId === eventId &&
          request.status === 'accepted' &&
          request.id !== currentRequestId &&
          request.slotId
        ) {
          const cancelled = transitionSlotRequest(
            request,
            'cancelled',
            this.deps.config.clock.now(),
          );
          await this.deps.repositories.slotRequests.transitionForSlot(request, cancelled);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  /**
   * Private event activation must not leave a known poster readable without
   * authorization. Only the configured storage provider may resolve/revoke
   * its own generated poster URLs; unknown/external URLs keep activation shut.
   */
  private async revokePrivatePoster(
    imageUrl: string | null,
    organizationId: EntityId,
  ): Promise<string | null> {
    if (imageUrl === null) return null;
    const storagePath = await this.deps.objectStorage.revokePublicRead(
      imageUrl,
      `posters/${organizationId}/`,
    );
    if (storagePath === null) {
      throw new InvalidOperationError(
        'Private events require artwork hosted in managed storage so public access can be revoked',
      );
    }
    this.deps.logger.info('events.private_poster_public_read_revoked', {
      provider: this.deps.objectStorage.name,
    });
    return storagePath;
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
      ...(source.media ? { media: source.media } : {}),
      imageUrl:
        source.visibilityMode === 'code' || source.visibilityMode === 'invited'
          ? null
          : source.imageUrl,
      privateImageStoragePath:
        source.visibilityMode === 'code' || source.visibilityMode === 'invited'
          ? ((await this.revokePrivatePoster(source.imageUrl, actor.organizationId)) ??
            source.privateImageStoragePath ??
            null)
          : null,
      startAt: source.startAt,
      endAt: source.endAt,
      tags: source.tags,
      refundPolicy: source.refundPolicy,
      compensation: source.compensation,
      visibilityMode: source.visibilityMode ?? 'public',
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(copy);
    await emit(this.deps, actor, copy.id, 'event.created', {
      title: copy.title,
      venueId: copy.venueId ?? '',
    });
    return copy;
  }

  /**
   * Preview: the event plus its public visibility flag (cached surface).
   *
   * Tenant-scoped like every other read — a preview of a *draft* exposes the
   * full uncompiled event (compensation, description, tags), so an unscoped
   * `getById` would be a cross-tenant IDOR on unpublished events.
   */
  async getPreview(
    actor: ActorContext,
    eventId: EntityId,
  ): Promise<{ event: Event; isPublic: boolean }> {
    const event = await this.fetchOwned(actor, eventId);
    return { event, isPublic: event.isPublic };
  }

  /** Direct status transition used by idempotent flows (validate-then-transition). */
  async transitionTo(actor: ActorContext, eventId: EntityId, to: EventStatus): Promise<Event> {
    const event = await this.fetchOwned(actor, eventId);
    if (
      event.externalLocation &&
      (to === 'review' || to === 'published') &&
      event.externalLocation.review.status !== 'approved'
    )
      throw new InvalidOperationError(
        'C1RCLE must approve the external venue before this event can progress',
      );
    if (event.status === 'postponed' && to === 'published')
      throw new InvalidOperationError(
        'Announce a replacement date before resuming a postponed event',
      );
    const updated = transitionEvent(event, to, this.deps.config.clock.now());
    if (updated === event) return event;
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
