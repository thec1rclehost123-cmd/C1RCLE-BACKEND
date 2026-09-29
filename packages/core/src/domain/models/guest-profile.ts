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
  assertAdult(input.dateOfBirth);
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
  assertAdult(input.dateOfBirth);
  return {
    ...bumpVersion(existing, now),
    displayName: input.displayName.trim(),
    dateOfBirth: input.dateOfBirth,
    city: input.city.trim(),
    tastes: [...input.tastes],
    intents: [...input.intents],
  };
}

function assertAdult(dateOfBirth: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  const birth =
    match?.[1] !== undefined && match?.[2] !== undefined && match?.[3] !== undefined
      ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      : null;
  if (birth === null || Number.isNaN(birth.getTime())) {
    throw new InvalidOperationError('Date of birth must be YYYY-MM-DD.');
  }
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const hadBirthday =
    now.getUTCMonth() > birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() >= birth.getUTCDate());
  if (!hadBirthday) age -= 1;
  if (age < 18) {
    throw new InvalidOperationError('Guest must be at least 18 years old.');
  }
}
