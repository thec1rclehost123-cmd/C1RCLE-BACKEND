import { InvalidOperationError } from '../../domain/errors.js';
import {
  createGuestProfile,
  updateGuestProfile,
  saveGuestOnboarding,
  isGuestOnboardingComplete,
  GUEST_INTERESTS,
} from '../../domain/models/guest-profile.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  GuestProfile,
  UpsertGuestProfileInput,
  GuestOnboardingPatch,
} from '../../domain/models/guest-profile.js';
import type { GuestProfileRepository } from '../../domain/ports/repositories.js';
import type { VerificationProvider } from '../../domain/ports/verification.js';
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
  getOnboarding(userId: EntityId): Promise<{
    profile: GuestProfile | null;
    complete: boolean;
    interestOptions: readonly string[];
  }>;
  saveOnboarding(userId: EntityId, patch: GuestOnboardingPatch): Promise<GuestProfile>;
  verifyPhone(
    userId: EntityId,
    phone: string,
    proofToken: string,
    verifier: VerificationProvider,
  ): Promise<GuestProfile>;
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

  async function saveOnboarding(
    userId: EntityId,
    patch: GuestOnboardingPatch,
  ): Promise<GuestProfile> {
    const existing = await guestProfiles.getByUserId(userId);
    const profile = saveGuestOnboarding(userId, existing, patch, config.clock.now());
    await guestProfiles.save(profile);
    return profile;
  }

  async function verifyPhone(
    userId: EntityId,
    phone: string,
    proofToken: string,
    verifier: VerificationProvider,
  ): Promise<GuestProfile> {
    if (!/^\+[1-9]\d{7,14}$/.test(phone) || !proofToken)
      throw new InvalidOperationError('Enter a valid phone number and verification code.');
    const result = await verifier.verify({
      documentType: 'phone',
      documentNumber: phone,
      proofToken,
    });
    if (!result.passed || result.provider !== 'firebase-phone')
      throw new InvalidOperationError(
        'Phone verification failed. Request a new code and try again.',
      );
    const existing = await guestProfiles.getByUserId(userId);
    const now = config.clock.now();
    const profile = {
      ...saveGuestOnboarding(userId, existing, {}, now),
      phoneNumber: phone,
      phoneVerifiedAt: now.toISOString(),
    };
    await guestProfiles.save(profile);
    return profile;
  }

  const getOnboarding = async (userId: EntityId) => {
    const profile = await guestProfiles.getByUserId(userId);
    return {
      profile,
      complete: isGuestOnboardingComplete(profile),
      interestOptions: GUEST_INTERESTS,
    };
  };
  return { getMine, upsertMine, saveOnboarding, verifyPhone, getOnboarding };
}
