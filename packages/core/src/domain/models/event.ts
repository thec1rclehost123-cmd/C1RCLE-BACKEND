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
  | 'started'
  | 'ended'
  | 'archived'
  | 'cancelled';

export const EVENT_STATUSES: readonly EventStatus[] = [
  'draft',
  'review',
  'scheduled',
  'published',
  'sales_paused',
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
  scheduled: ['published', 'started', 'cancelled'],
  published: ['sales_paused', 'started', 'cancelled'],
  sales_paused: ['published', 'started', 'cancelled'],
  started: ['ended'],
  ended: ['archived'],
  archived: [],
  cancelled: [],
};

export interface TicketTierRef {
  tierId: EntityId;
  priceInPaise: number;
  quantity: number;
}

export interface Event extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
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
  /** ISO-8601 timestamps. */
  startAt: string;
  endAt: string | null;
  status: EventStatus;
  /** Caching visibility derived from status (public vs internal). */
  isPublic: boolean;
  /** Opaque tags — presentation only. */
  tags: string[];
  /** Base price when a single price is offered. */
  startingPricePaise: number | null;
  isFree: boolean;
  /** Reason/meta recorded when CANCELLED. */
  cancellationReason: string | null;
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
  venueId: EntityId;
  title: string;
  summary?: string;
  description?: string;
  imageUrl?: string | null;
  startAt: string;
  endAt?: string | null;
  tags?: string[];
  now?: Date;
}

/** Slugify like V1 (`events.ts` slug convention): lowercase, `-` for spaces. */
export function slugifyEventTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function createEvent(input: CreateEventInput): Event {
  const now = input.now ?? new Date();
  return {
    id: input.id,
    organizationId: input.organizationId,
    venueId: input.venueId,
    slug: slugifyEventTitle(input.title) || input.id,
    title: input.title,
    status: 'draft',
    isPublic: false,
    summary: input.summary ?? '',
    description: input.description ?? '',
    imageUrl: input.imageUrl ?? null,
    startAt: input.startAt,
    endAt: input.endAt ?? null,
    tags: input.tags ?? [],
    startingPricePaise: 0,
    isFree: true,
    cancellationReason: null,
    adminOverride: false,
    ...newVersionedEntity(now),
  };
}

interface EventChanges {
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
}

/** Controlled attribute update (no status changes here). Bumps version. */
export function updateEvent(event: Event, changes: EventChanges, now?: Date): Event {
  const stamped = bumpVersion(event, now ?? new Date());
  return { ...stamped, ...changes };
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
    isPublic: computeIsPublic(next),
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

function computeIsPublic(status: EventStatus): boolean {
  return status === 'published' || status === 'sales_paused' || status === 'started';
}

export function isPublicStatus(status: EventStatus): boolean {
  return computeIsPublic(status);
}
