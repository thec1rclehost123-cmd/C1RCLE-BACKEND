import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Guest profile ─────────────────────────────────────────────────────────
 * The guest-portal signup onboarding (preferred name, date of birth, city,
 * tastes, intents), one doc per session user id. Timestamps are ISO strings
 * (see `identity.ts`); the 18+ rule lives here so every writer — the gateway
 * today, any future importer — enforces it identically.
 */
export interface GuestProfile extends VersionedEntity {
  userId: EntityId;
  displayName: string;
  /** Calendar date, `YYYY-MM-DD`. */
  dateOfBirth: string;
  city: string;
  tastes: string[];
  intents: string[];
  /** Private verified contact; only server verification may write these fields. */
  phoneNumber?: string;
  phoneVerifiedAt?: string;
}

export interface UpsertGuestProfileInput {
  displayName: string;
  dateOfBirth: string;
  city: string;
  tastes: string[];
  intents: string[];
  now?: Date;
}

export function createGuestProfile(userId: EntityId, input: UpsertGuestProfileInput): GuestProfile {
  const now = input.now ?? new Date();
  assertAdult(input.dateOfBirth, now);
  return {
    userId,
    displayName: input.displayName.trim(),
    dateOfBirth: input.dateOfBirth,
    city: input.city.trim(),
    tastes: [...input.tastes],
    intents: [...input.intents],
    ...newVersionedEntity(now),
  };
}

export function updateGuestProfile(
  existing: GuestProfile,
  input: UpsertGuestProfileInput,
): GuestProfile {
  const now = input.now ?? new Date();
  assertAdult(input.dateOfBirth, now);
  return {
    ...bumpVersion(existing, now),
    displayName: input.displayName.trim(),
    dateOfBirth: input.dateOfBirth,
    city: input.city.trim(),
    tastes: [...input.tastes],
    intents: [...input.intents],
  };
}

function assertAdult(dateOfBirth: string, now: Date): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  const birth =
    match?.[1] !== undefined && match?.[2] !== undefined && match?.[3] !== undefined
      ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      : null;
  if (
    birth === null ||
    Number.isNaN(birth.getTime()) ||
    birth.toISOString().slice(0, 10) !== dateOfBirth
  ) {
    throw new InvalidOperationError('Date of birth must be YYYY-MM-DD.');
  }
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const hadBirthday =
    now.getUTCMonth() > birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() >= birth.getUTCDate());
  if (!hadBirthday) age -= 1;
  if (age < 18) {
    throw new InvalidOperationError('Guest must be at least 18 years old.');
  }
}

/** V1 choices stored in the existing private `tastes` field. */
export const GUEST_INTERESTS = [
  'Techno',
  'House',
  'Hip-Hop',
  'Bollywood',
  'Live Music',
  'Festivals',
  'College Events',
  'Comedy',
  'Food & Experiences',
] as const;

export interface GuestOnboardingPatch {
  displayName?: string;
  dateOfBirth?: string;
  tastes?: string[];
}

export function saveGuestOnboarding(
  userId: EntityId,
  existing: GuestProfile | null,
  patch: GuestOnboardingPatch,
  now: Date,
): GuestProfile {
  const profile: GuestProfile = existing
    ? { ...bumpVersion(existing, now), tastes: [...existing.tastes] }
    : {
        userId,
        displayName: '',
        dateOfBirth: '',
        city: '',
        tastes: [],
        intents: [],
        ...newVersionedEntity(now),
      };
  if (patch.displayName !== undefined) {
    const name = patch.displayName.trim();
    if (name.length < 2 || name.length > 200)
      throw new InvalidOperationError('Enter a name between 2 and 200 characters.');
    profile.displayName = name;
  }
  if (patch.dateOfBirth !== undefined) {
    assertAdult(patch.dateOfBirth, now);
    profile.dateOfBirth = patch.dateOfBirth;
  }
  if (patch.tastes !== undefined) {
    const tastes = [...new Set(patch.tastes)];
    if (
      tastes.length < 1 ||
      tastes.length > GUEST_INTERESTS.length ||
      tastes.some((value) => !GUEST_INTERESTS.some((interest) => interest === value))
    )
      throw new InvalidOperationError('Choose at least one listed interest.');
    profile.tastes = tastes;
  }
  return profile;
}

export function isGuestOnboardingComplete(profile: GuestProfile | null): boolean {
  return Boolean(
    profile &&
    profile.displayName.trim().length >= 2 &&
    profile.dateOfBirth &&
    profile.phoneNumber &&
    profile.phoneVerifiedAt &&
    profile.tastes.length > 0,
  );
}
