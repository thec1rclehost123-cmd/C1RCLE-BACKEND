import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { newVersionedEntity, bumpVersion } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Event aggregate + explicit state machine ────────────────────────────────
 * Replaces V1's `lifecycle`/`status` string soup with one typed status and an
 * explicit allowed-transitions table. Every transition is validated; the same
 * transition is an idempotent no-op (safe to retry).
 *
 *   DRAFT → REVIEW → SCHEDULED → PUBLISHED ⇄ SALES_PAUSED → STARTED → ENDED → ARCHIVED
 *   any-remaining → CANCELLED (terminal)
 */

export type EventStatus =
  | 'draft'
  | 'review'
  | 'scheduled'
  | 'published'
  | 'sales_paused'
  | 'postponed'
  | 'started'
  | 'ended'
  | 'archived'
  | 'cancelled';

/** Unlisted links are not confidential; code/invited events require an identity-bound grant. */
export type EventVisibilityMode = 'public' | 'unlisted' | 'code' | 'invited';
export type EventAddressDisclosure = 'public' | 'after_grant' | 'hidden';

export const EVENT_STATUSES: readonly EventStatus[] = [
  'draft',
  'review',
  'scheduled',
  'published',
  'sales_paused',
  'postponed',
  'started',
  'ended',
  'archived',
  'cancelled',
];

/**
 * Explicit allowed-transitions table. `null` entry = no valid source. This is
 * the single source of truth — adding a transition requires editing this map.
 */
export const EVENT_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ['review', 'cancelled'],
  review: ['scheduled', 'draft', 'cancelled'],
  scheduled: ['published', 'postponed', 'started', 'cancelled'],
  published: ['sales_paused', 'postponed', 'started', 'cancelled'],
  sales_paused: ['published', 'postponed', 'started', 'cancelled'],
  postponed: ['published', 'cancelled'],
  started: ['ended', 'postponed', 'cancelled'],
  ended: ['archived'],
  archived: [],
  cancelled: [],
};

/** Terminal statuses: no outbound transitions and no attribute mutation. */
const TERMINAL_EVENT_STATUSES: readonly EventStatus[] = ['cancelled', 'archived'];

export function isTerminalEventStatus(status: EventStatus): boolean {
  return TERMINAL_EVENT_STATUSES.includes(status);
}

/**
 * Rejects attribute updates on a terminal event. `EVENT_TRANSITIONS` already
 * freezes status changes, but `updateEvent` (title/pricing/promo/…) would
 * otherwise still rewrite a cancelled or archived event.
 */
function assertEventMutable(event: Event): void {
  if (isTerminalEventStatus(event.status)) {
    throw new InvalidOperationError(`A ${event.status} event is terminal and cannot be modified`);
  }
}

export interface TicketTierRef {
  tierId: EntityId;
  priceInPaise: number;
  quantity: number;
}

export type CompensationModel = 'standard' | 'custom' | 'salary';
export type SalaryPeriod = 'per_event' | 'per_day' | 'per_month';

export interface EventRefundPolicy {
  kind: 'no_refunds' | 'until_cutoff' | 'organizer_reviewed';
  cutoffAt?: string | null;
}

export function assertEventRefundPolicy(policy: EventRefundPolicy | undefined): void {
  if (!policy) return;
  if (
    !['no_refunds', 'until_cutoff', 'organizer_reviewed'].includes(policy.kind) ||
    (policy.kind === 'until_cutoff' && !Number.isFinite(Date.parse(policy.cutoffAt ?? '')))
  )
    throw new InvalidOperationError('A refund-request cutoff must have a valid date');
}

export interface EventCompensation {
  model: CompensationModel;
  globalRatePercent: number | null;
  tierRates: Record<string, number>;
  salaryAmountPaise: number | null;
  salaryPeriod: SalaryPeriod | null;
  salaryNotes: string | null;
}

/** Server-owned venue and entry information shown on the Guest event detail. */
export interface EventEntryRules {
  doorsOpenAt: string | null;
  lastEntryAt: string | null;
  reentryAllowed: boolean | null;
  minimumAge: number | null;
  idRequired: boolean | null;
  accessibilityNotes: string | null;
  dressCode: string | null;
  alcoholPolicy: string | null;
  prohibitedItems: string[];
  supportDetails: string | null;
}

export interface EventMedia {
  titleFont?:
    'classic' | 'eclectic' | 'fancy' | 'digital' | 'literary' | 'impact' | 'modern' | 'condensed';
  youtubeUrl: string | null;
  gallery: { url: string; alt: string }[];
  spotlights: {
    id: string;
    title: string;
    link: string | null;
    imageUrl: string | null;
    description: string;
    startTime: string | null;
    endTime: string | null;
  }[];
}

/** Immutable event-scoped location for a physical venue without a C1RCLE account. */
export interface ExternalEventLocation {
  name: string;
  address: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  mapUrl?: string | null;
  contact: { managerName: string; phone: string; email?: string | null };
  review: {
    status: 'pending' | 'approved' | 'rejected';
    submittedAt: string;
    reviewedAt: string | null;
    reviewedBy: EntityId | null;
    rejectionReason: string | null;
  };
}

function assertMediaVisibility(
  media: EventMedia | undefined,
  visibility: EventVisibilityMode | undefined,
) {
  if (
    (visibility === 'code' || visibility === 'invited') &&
    media &&
    (media.gallery.length || media.spotlights.some((item) => item.imageUrl))
  ) {
    throw new InvalidOperationError(
      'Gallery and spotlight images are currently available for public or unlisted events only',
    );
  }
}

function hasValidExternalContactEmail(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..'))
    return false;
  const labels = domain.split('.');
  return (
    labels.length > 1 &&
    labels.every(
      (label) =>
        label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'),
    )
  );
}

export interface Event extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  externalLocation?: ExternalEventLocation;
  /**
   * URL-safe public identifier — V1 events always carried one and the public
   * surface addresses events by `idOrSlug`. Server-derived at create
   * (`slugify(title)`), overridable via update.
   */
  slug: string;
  title: string;
  /** Public blurb shown to guests. */
  summary: string;
  /** Full public description. */
  description: string;
  imageUrl: string | null;
  /** Managed poster key retained only for grant-authorized private reads. */
  privateImageStoragePath?: string | null;
  /** ISO-8601 timestamps. */
  startAt: string;
  endAt: string | null;
  lastMaterialChangeAt?: string;
  status: EventStatus;
  /** Missing on legacy records means public. Private modes require a verified grant for detail. */
  visibilityMode?: EventVisibilityMode;
  /** Fine-grained venue address access; private legacy events fail closed. */
  addressDisclosure?: EventAddressDisclosure;
  /** Discovery visibility derived from event status and visibility mode. */
  isPublic: boolean;
  /** Opaque tags — presentation only. */
  tags: string[];
  /** Base price when a single price is offered. */
  startingPricePaise: number | null;
  isFree: boolean;
  /** Reason/meta recorded when CANCELLED. */
  cancellationReason: string | null;
  /** Last postponement; dates remain historical until explicit rescheduling. */
  postponement?: {
    reason: string;
    initiatedBy: 'host' | 'venue';
    organizationId: EntityId;
    at: string;
  } | null;
  refundPolicy?: EventRefundPolicy;
  compensation?: EventCompensation | null;
  entryRules?: EventEntryRules;
  media?: EventMedia;
  /**
   * Total people the room legally holds, for the door's occupancy gauge.
   *
   * Nullable on purpose: many events genuinely have no fixed cap, and a
   * fabricated default (the old scanner UI hardcoded 500) tells door staff a
   * confident number nobody set. `null` means "not configured" and the door
   * shows occupancy without a limit rather than inventing one.
   *
   * This is NOT ticket inventory. Tier quantities decide what can be sold;
   * capacity decides when the fire marshal stops the night.
   */
  capacity: number | null;
  /**
   * True while the current `sales_paused` state was forced by a platform
   * admin rather than the partner pausing their own sales. Lets partner UI
   * tell an admin halt apart from a self-pause instead of showing the same
   * "paused" badge for both (v1's `adminStore.js:509` did this with the
   * same flag name).
   */
  adminOverride: boolean;
}

export interface CreateEventInput {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  externalLocation?: ExternalEventLocation;
  title: string;
  summary?: string;
  description?: string;
  imageUrl?: string | null;
  privateImageStoragePath?: string | null;
  startAt: string;
  endAt?: string | null;
  tags?: string[];
  refundPolicy?: EventRefundPolicy;
  compensation?: EventCompensation | null;
  capacity?: number | null;
  visibilityMode?: EventVisibilityMode;
  addressDisclosure?: EventAddressDisclosure;
  entryRules?: EventEntryRules;
  media?: EventMedia;
  now?: Date;
}

/** Slugify like V1 (`events.ts` slug convention): lowercase, `-` for spaces.
 *
 * The dash trim is a plain index scan, not a regex. `/^-+|-+$/g` and even a
 * lone `/-+$/` are quadratic in the length of the input: the engine retries
 * the `-+` run from every start position and only then fails the `$` anchor.
 * A title is partner-supplied, so that shape is reachable in principle and
 * CodeQL reports it as `js/polynomial-redos`. The scan below is linear.
 *
 * The result is unchanged: it strips the whole run of leading and trailing
 * dashes, exactly what the `g`-flagged alternation did.
 */
export function slugifyEventTitle(title: string): string {
  return trimDashes(
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-'),
  ).slice(0, 80);
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

export function createEvent(input: CreateEventInput): Event {
  assertEventRefundPolicy(input.refundPolicy);
  const now = input.now ?? new Date();
  if (input.entryRules?.reentryAllowed === true)
    throw new InvalidOperationError('Automatic re-entry is unavailable in V1');
  assertMediaVisibility(input.media, input.visibilityMode);
  if ((input.venueId === null) === (input.externalLocation === undefined)) {
    throw new InvalidOperationError('Choose either a C1RCLE Venue or an external event location');
  }
  if (input.externalLocation) {
    const location = input.externalLocation;
    if (!location.name.trim() || !location.address.trim() || !location.contact.managerName.trim())
      throw new InvalidOperationError('External venue name, address and manager are required');
    if (!/^\+?[\d\s()-]{10,18}$/.test(location.contact.phone.trim()))
      throw new InvalidOperationError('Enter a valid external venue manager phone number');
    if (location.contact.email && !hasValidExternalContactEmail(location.contact.email))
      throw new InvalidOperationError('Enter a valid external venue manager email');
  }
  return {
    id: input.id,
    organizationId: input.organizationId,
    venueId: input.venueId,
    ...(input.externalLocation ? { externalLocation: input.externalLocation } : {}),
    slug: slugifyEventTitle(input.title) || input.id,
    title: input.title,
    status: 'draft',
    isPublic: false,
    visibilityMode: input.visibilityMode ?? 'public',
    addressDisclosure:
      input.addressDisclosure ??
      (input.visibilityMode === 'code' || input.visibilityMode === 'invited' ? 'hidden' : 'public'),
    summary: input.summary ?? '',
    description: input.description ?? '',
    imageUrl: input.imageUrl ?? null,
    privateImageStoragePath: input.privateImageStoragePath ?? null,
    startAt: input.startAt,
    endAt: input.endAt ?? null,
    tags: input.tags ?? [],
    startingPricePaise: 0,
    isFree: true,
    cancellationReason: null,
    refundPolicy: input.refundPolicy ?? { kind: 'organizer_reviewed' },
    compensation: input.compensation ?? null,
    ...(input.entryRules === undefined ? {} : { entryRules: input.entryRules }),
    ...(input.media === undefined ? {} : { media: input.media }),
    capacity: input.capacity ?? null,
    adminOverride: false,
    ...newVersionedEntity(now),
  };
}

interface EventChanges {
  venueId?: EntityId;
  slug?: string;
  title?: string;
  summary?: string;
  description?: string;
  imageUrl?: string | null;
  privateImageStoragePath?: string | null;
  startAt?: string;
  endAt?: string | null;
  tags?: string[];
  startingPricePaise?: number;
  isFree?: boolean;
  refundPolicy?: EventRefundPolicy;
  compensation?: EventCompensation | null;
  capacity?: number | null;
  visibilityMode?: EventVisibilityMode;
  addressDisclosure?: EventAddressDisclosure;
  entryRules?: EventEntryRules;
  media?: EventMedia;
}

/** Controlled attribute update (no status changes here). Bumps version. */
export function updateEvent(event: Event, changes: EventChanges, now?: Date): Event {
  assertEventMutable(event);
  assertEventRefundPolicy(changes.refundPolicy);
  if (changes.entryRules?.reentryAllowed === true)
    throw new InvalidOperationError('Automatic re-entry is unavailable in V1');
  const stamped = bumpVersion(event, now ?? new Date());
  const updated = { ...stamped, ...changes };
  assertMediaVisibility(updated.media, updated.visibilityMode);
  return {
    ...updated,
    // Preserve legacy/manual hidden state on unrelated edits. Only an explicit
    // visibility-mode change may recompute the discovery projection.
    isPublic:
      changes.visibilityMode === undefined
        ? event.isPublic
        : computeIsPublic(updated.status, updated.visibilityMode ?? 'public'),
  };
}

/**
 * Validates a status transition against the table. Throws
 * `StateTransitionError` for illegal moves; same-state is a no-op returning
 * the unchanged status.
 */
export function transitionEventStatus(from: EventStatus, to: EventStatus): EventStatus {
  return transitionStatus(from, to, EVENT_TRANSITIONS);
}

/**
 * Applies a validated transition to an event. Idempotent: asking for the
 * current status returns the event unchanged (retry-safe).
 */
export function transitionEvent(event: Event, to: EventStatus, now?: Date): Event {
  if (event.status === to) return event;
  if (event.status === 'cancelled') {
    throw new InvalidOperationError('A cancelled event is terminal');
  }
  // Validate BEFORE mutating; StateTransitionError bubbles as a domain error.
  const next = transitionStatus(event.status, to, EVENT_TRANSITIONS);
  const stamped = bumpVersion(event, now ?? new Date());
  return {
    ...stamped,
    status: next,
    isPublic: computeIsPublic(next, event.visibilityMode ?? 'public'),
    // Any real status change clears an admin override — `adminPauseEvent`
    // re-sets it explicitly right after calling this. A self-pause or a
    // partner's own resume should never carry a stale override flag.
    adminOverride: false,
  };
}

export function cancelEvent(event: Event, reason: string, now?: Date): Event {
  if (event.status === 'cancelled') return event;
  transitionStatus(event.status, 'cancelled', EVENT_TRANSITIONS);
  const stamped = bumpVersion(event, now ?? new Date());
  return { ...stamped, status: 'cancelled', isPublic: false, cancellationReason: reason };
}

/** Records an external-location decision; privileged actor checks belong to the application boundary. */
export function decideExternalLocationReview(
  event: Event,
  decision: { approved: boolean; reviewerId: EntityId; reason?: string | null; now?: Date },
): Event {
  const location = event.externalLocation;
  if (!location) throw new InvalidOperationError('Event has no external location to review');
  if (location.review.status !== 'pending')
    throw new InvalidOperationError('Only a pending external location can be reviewed');
  const at = decision.now ?? new Date();
  const reason = decision.reason?.trim();
  return {
    ...bumpVersion(event, at),
    externalLocation: {
      ...location,
      review: {
        status: decision.approved ? 'approved' : 'rejected',
        submittedAt: location.review.submittedAt,
        reviewedAt: at.toISOString(),
        reviewedBy: decision.reviewerId,
        rejectionReason: decision.approved
          ? null
          : reason && reason.length > 0
            ? reason
            : 'Please provide additional venue evidence.',
      },
    },
  };
}

/** Resubmission retains the historical location snapshot and starts a fresh review cycle. */
export function resubmitExternalLocation(
  event: Event,
  submission: Omit<ExternalEventLocation, 'review'>,
  now?: Date,
): Event {
  const location = event.externalLocation;
  if (!location || location.review.status !== 'rejected')
    throw new InvalidOperationError('Only a rejected external location can be resubmitted');
  const at = now ?? new Date();
  return {
    ...bumpVersion(event, at),
    externalLocation: {
      ...submission,
      review: {
        status: 'pending',
        submittedAt: at.toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      },
    },
  };
}

/** Freeze the canonical event without erasing its last announced schedule. */
export function postponeEvent(
  event: Event,
  reason: string,
  initiatedBy: 'host' | 'venue',
  organizationId: EntityId,
  now: Date,
): Event {
  if (!reason.trim()) throw new InvalidOperationError('A postponement reason is required');
  if (
    event.status === 'postponed' &&
    !(initiatedBy === 'venue' && event.postponement?.initiatedBy !== 'venue')
  )
    return event;
  const updated =
    event.status === 'postponed'
      ? bumpVersion(event, now)
      : transitionEvent(event, 'postponed', now);
  return {
    ...updated,
    postponement: { reason: reason.trim(), initiatedBy, organizationId, at: now.toISOString() },
  };
}

const PAUSABLE_STATUSES: readonly EventStatus[] = ['published', 'sales_paused'];

/**
 * Admin pause (`EVENT_PAUSE`, TIER1 — any admin, merely logged). Only
 * reachable from `published`/already-`sales_paused`: the terminal-state
 * guard is the FSM table itself (`sales_paused` has no inbound edge from
 * `draft`/`scheduled`/`started`/`ended`/`archived`/`cancelled`), but this
 * explicit check gives a clear message instead of a generic
 * `StateTransitionError` — v1's equivalent guard (`adminStore.js:500-502`)
 * used the same "cannot pause a completed or past event" wording.
 */
export function adminPauseEvent(event: Event, now?: Date): Event {
  if (!PAUSABLE_STATUSES.includes(event.status)) {
    throw new InvalidOperationError('Cannot pause a completed, past, or cancelled event');
  }
  if (event.status === 'sales_paused') {
    if (event.adminOverride) return event;
    return { ...bumpVersion(event, now ?? new Date()), adminOverride: true };
  }
  return { ...transitionEvent(event, 'sales_paused', now), adminOverride: true };
}

/** Admin resume (`EVENT_RESUME`, TIER1). Reverses `adminPauseEvent`. */
export function adminResumeEvent(event: Event, now?: Date): Event {
  if (!PAUSABLE_STATUSES.includes(event.status)) {
    throw new InvalidOperationError('Cannot resume a completed, past, or cancelled event');
  }
  return transitionEvent(event, 'published', now);
}

/**
 * Sources an admin may force-complete from. This is the one *admin-only* FSM
 * edge — it is deliberately NOT in the public `EVENT_TRANSITIONS` table, which
 * only allows `started → ended` automatically. A partner must never force-end
 * their own event; only a platform admin may, so the edge is enforced here by
 * this explicit guard (same pattern as the `PAUSABLE_STATUSES` guard above
 * rather than a duplicated public-edge entry).
 */
const FORCE_COMPLETABLE_STATUSES: readonly EventStatus[] = ['published', 'sales_paused', 'started'];

/**
 * Admin force-complete (`EVENT_FORCE_PAUSE`, TIER1 — any admin, merely
 * logged). The admin-only FSM edge that force-ends a past event whose
 * lifecycle never transitioned on its own (a sales window that closed days
 * ago but is still `published`, a `started` event that never hit `ended`,
 * etc.). Stamps `adminOverride` so the admin trail records the end was forced,
 * and clears `isPublic` exactly like a natural `ended`.
 */
export function adminForceCompleteEvent(event: Event, now?: Date): Event {
  if (event.status === 'ended') return event;
  if (!FORCE_COMPLETABLE_STATUSES.includes(event.status)) {
    throw new InvalidOperationError(
      'Cannot force-complete a draft, review, scheduled, completed, archived, or cancelled event',
    );
  }
  const stamped = bumpVersion(event, now ?? new Date());
  return { ...stamped, status: 'ended', isPublic: false, adminOverride: true };
}

function computeIsPublic(
  status: EventStatus,
  visibilityMode: EventVisibilityMode = 'public',
): boolean {
  return (
    visibilityMode === 'public' &&
    (status === 'published' || status === 'sales_paused' || status === 'started')
  );
}

export function isPublicStatus(status: EventStatus): boolean {
  return computeIsPublic(status);
}
