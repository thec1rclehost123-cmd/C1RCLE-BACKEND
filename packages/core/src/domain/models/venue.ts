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
  /** Public-facing config (guest list toggle etc.). */
  settings: VenuePublicSettings;
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
