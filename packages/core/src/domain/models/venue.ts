import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { newVersionedEntity, bumpVersion } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Venue aggregate ────────────────────────────────────────────────────────
 * VenueProfile is split into public (guest-facing) and private (partner-owned)
 * fields so serialization can never leak contact/business details to guests.
 */

export interface VenuePublicProfile {
  name: string;
  slug: string;
  description: string;
  shortDescription?: string;
  photoUrl: string | null;
  address: VenueAddress;
  facilities: string[];
  capacity: number | null;
  /**
   * Food/drink offering shown to guests. Public by nature: it is menu copy,
   * not commercial terms — pricing that must not leak belongs on the private
   * profile, not here.
   */
  menu: VenueMenu;
  /** Public-facing config (guest list toggle etc.). */
  settings: VenuePublicSettings;
}

/**
 * ─── Menu ─────────────────────────────────────────────────────────────────────
 * Deliberately a flat list of named sections rather than a deep catalogue:
 * this is the display menu a guest reads, not the inventory the kitchen runs.
 * Ticketed products live in the event catalog, priced in paise.
 */
export interface VenueMenu {
  sections: VenueMenuSection[];
  /** ISO-8601; lets a client show "updated on …" without another read. */
  updatedAt: string | null;
}

export interface VenueMenuSection {
  name: string;
  items: VenueMenuItem[];
}

export interface VenueMenuItem {
  name: string;
  description?: string;
  /** Integer paise, matching every other money field in the system. */
  pricePaise: number | null;
  /** Dietary/allergen tags — presentation only, never a business rule. */
  tags: string[];
}

export const EMPTY_MENU: VenueMenu = { sections: [], updatedAt: null };

export interface UpdateMenuInput {
  sections: VenueMenuSection[];
  now?: Date;
}

/**
 * Replaces the menu wholesale. A partial merge would make removing an item
 * impossible to express, which is the operation a venue most often wants.
 */
export function updateVenueMenu(venue: Venue, input: UpdateMenuInput): Venue {
  const now = input.now ?? new Date();
  for (const section of input.sections) {
    for (const item of section.items) {
      if (item.pricePaise !== null && item.pricePaise !== undefined && item.pricePaise < 0) {
        throw new InvalidOperationError(`Menu item "${item.name}" cannot have a negative price`);
      }
    }
  }
  const stamped = bumpVersion(venue, now);
  return {
    ...stamped,
    public: {
      ...venue.public,
      menu: { sections: input.sections, updatedAt: now.toISOString() },
    },
  };
}

export interface VenuePrivateProfile {
  contactEmail: string | null;
  contactPhone: string | null;
  socials: {
    instagram?: string;
    website?: string;
    facebook?: string;
  };
  /** Internal notes — never exposed over public APIs. */
  internalNotes: string;
}

export interface VenuePublicSettings {
  showGuestList: boolean;
  activityEnabled: boolean;
}

export interface VenueAddress {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface Venue extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  ownerId: EntityId;
  status: VenueStatus;
  public: VenuePublicProfile;
  private: VenuePrivateProfile;
}

export type VenueStatus = 'active' | 'suspended';

export interface CreateVenueInput {
  id: EntityId;
  organizationId: EntityId;
  ownerId: EntityId;
  name: string;
  slug: string;
  /** V1-proven create fields (previous backend always wrote these at create). */
  description?: string;
  capacity?: number | null;
  city?: string | null;
  now?: Date;
}

export function createVenue(input: CreateVenueInput): Venue {
  return {
    id: input.id,
    organizationId: input.organizationId,
    ownerId: input.ownerId,
    status: 'active',
    public: {
      name: input.name,
      slug: input.slug,
      description: input.description ?? '',
      photoUrl: null,
      address: input.city === undefined || input.city === null ? {} : { city: input.city },
      facilities: [],
      menu: EMPTY_MENU,
      capacity: input.capacity ?? null,
      settings: { showGuestList: false, activityEnabled: false },
    },
    private: {
      contactEmail: null,
      contactPhone: null,
      socials: {},
      internalNotes: '',
    },
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

export interface VenueUpdate {
  public?: Partial<VenuePublicProfile>;
  private?: Partial<VenuePrivateProfile>;
}

/** Applies a controlled update; version bumps on every write. */
export function updateVenue(venue: Venue, update: VenueUpdate, now?: Date): Venue {
  const stamped = bumpVersion(venue, now ?? new Date());
  return {
    ...stamped,
    public: { ...venue.public, ...(update.public ?? {}) },
    private: { ...venue.private, ...(update.private ?? {}) },
  };
}

/**
 * ─── Venue slots ──────────────────────────────────────────────────────────────
 * A slot is an offered time window (recurring intents handled upstream).
 */
export interface VenueSlot extends VersionedEntity {
  id: EntityId;
  venueId: EntityId;
  label: string;
  startTime: string;
  endTime: string;
  recurring: boolean;
  status: VenueSlotStatus;
  capacityFor: number | null;
}

export type VenueSlotStatus = 'open' | 'booked' | 'blocked' | 'cancelled';

/**
 * ─── Slot requests ────────────────────────────────────────────────────────────
 * A host asks for a slot; the venue accepts/rejects. FSM:
 *   PENDING → ACCEPTED
 *   PENDING → REJECTED
 *   ACCEPTED → CANCELLED
 */
export interface SlotRequest extends VersionedEntity {
  id: EntityId;
  venueId: EntityId;
  eventId: EntityId | null;
  hostId: EntityId;
  status: SlotRequestStatus;
  message?: string;
}

export type SlotRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

const SLOT_REQUEST_TRANSITIONS: Readonly<Record<SlotRequestStatus, readonly SlotRequestStatus[]>> =
  {
    pending: ['accepted', 'rejected'],
    accepted: ['cancelled'],
    rejected: [],
    cancelled: [],
  };

export function transitionSlotRequestStatus(
  from: SlotRequestStatus,
  to: SlotRequestStatus,
): SlotRequestStatus {
  if (from === to) {
    throw new InvalidOperationError('Slot request already in that state');
  }
  return transitionStatus(from, to, SLOT_REQUEST_TRANSITIONS);
}

export function transitionSlotRequest(
  request: SlotRequest,
  to: SlotRequestStatus,
  now?: Date,
): SlotRequest {
  const next = transitionSlotRequestStatus(request.status, to);
  return bumpVersion({ ...request, status: next }, now ?? new Date());
}

export function createSlotRequest(input: {
  id: EntityId;
  venueId: EntityId;
  eventId: EntityId | null;
  hostId: EntityId;
  message?: string;
  now?: Date;
}): SlotRequest {
  return {
    id: input.id,
    venueId: input.venueId,
    eventId: input.eventId,
    hostId: input.hostId,
    status: 'pending',
    message: input.message,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/* ─── Availability ─────────────────────────────────────────────────────────── */

/**
 * A derived, guest-facing view of a venue's calendar: how much of a window is
 * actually bookable. This is a *computation over slots*, not stored state —
 * storing it would create a second source of truth that drifts the moment a
 * slot changes.
 *
 * `cancelled` slots are excluded entirely rather than counted as unavailable:
 * a cancelled slot is one that no longer exists, not one that is taken.
 */
export interface VenueAvailability {
  venueId: EntityId;
  from: string;
  to: string;
  openSlots: number;
  bookedSlots: number;
  blockedSlots: number;
  /** Total minutes across open slots — the practical "how much can I book". */
  openMinutes: number;
  /** True when nothing in the window can be booked. */
  fullyBooked: boolean;
  slots: VenueAvailabilitySlot[];
}

export interface VenueAvailabilitySlot {
  id: EntityId;
  label: string;
  startTime: string;
  endTime: string;
  status: Exclude<VenueSlotStatus, 'cancelled'>;
  capacityFor: number | null;
}

export function computeVenueAvailability(input: {
  venueId: EntityId;
  from: string;
  to: string;
  slots: readonly VenueSlot[];
}): VenueAvailability {
  const live = input.slots.filter((slot) => slot.status !== 'cancelled');

  let openSlots = 0;
  let bookedSlots = 0;
  let blockedSlots = 0;
  let openMinutes = 0;

  for (const slot of live) {
    if (slot.status === 'open') {
      openSlots++;
      openMinutes += slotMinutes(slot);
    } else if (slot.status === 'booked') {
      bookedSlots++;
    } else {
      blockedSlots++;
    }
  }

  return {
    venueId: input.venueId,
    from: input.from,
    to: input.to,
    openSlots,
    bookedSlots,
    blockedSlots,
    openMinutes,
    // A window with no slots at all is not "fully booked" — there is simply
    // nothing published yet, which is a different thing to tell a caller.
    fullyBooked: live.length > 0 && openSlots === 0,
    slots: live.map((slot) => ({
      id: slot.id,
      label: slot.label,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: slot.status as Exclude<VenueSlotStatus, 'cancelled'>,
      capacityFor: slot.capacityFor,
    })),
  };
}

/** Duration in whole minutes; a non-positive or unparseable range counts as 0. */
function slotMinutes(slot: VenueSlot): number {
  const start = Date.parse(slot.startTime);
  const end = Date.parse(slot.endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return Math.round((end - start) / 60_000);
}
