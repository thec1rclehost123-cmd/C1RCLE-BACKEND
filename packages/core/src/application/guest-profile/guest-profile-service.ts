import { createGuestProfile, updateGuestProfile } from '../../domain/models/guest-profile.js';

import type { EntityId } from '../../domain/identity.js';
import type { GuestProfile, UpsertGuestProfileInput } from '../../domain/models/guest-profile.js';
import type { GuestProfileRepository } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Guest profile service ─────────────────────────────────────────────────
 * Session-scoped, never org-scoped: a guest belongs to no organization.
 * Like `EmailOtpService`, there is no `requireOrgAccess` gate — ownership is
 * the session user id itself, threaded explicitly (never read off the actor's
 * org, which is empty for session-only callers).
 */
export interface GuestProfileServiceDeps {
  guestProfiles: GuestProfileRepository;
  config: ServiceDeps['config'];
}

export interface GuestProfileService {
  getMine(userId: EntityId): Promise<GuestProfile | null>;
  upsertMine(userId: EntityId, input: UpsertGuestProfileInput): Promise<GuestProfile>;
}

export function createGuestProfileService(deps: GuestProfileServiceDeps): GuestProfileService {
  const { guestProfiles, config } = deps;

  async function getMine(userId: EntityId): Promise<GuestProfile | null> {
    return guestProfiles.getByUserId(userId);
  }

  async function upsertMine(
    userId: EntityId,
    input: UpsertGuestProfileInput,
  ): Promise<GuestProfile> {
    const now = config.clock.now();
    const existing = await guestProfiles.getByUserId(userId);
    const profile =
      existing === null
        ? createGuestProfile(userId, { ...input, now })
        : updateGuestProfile(existing, { ...input, now });
    await guestProfiles.save(profile);
    return profile;
  }

  return { getMine, upsertMine };
}
