import { isGuestOnboardingComplete } from '../../domain/models/guest-profile.js';

import type { GuestProfile } from '../../domain/models/guest-profile.js';
import type { PlatformUser } from '../../domain/models/platform-user.js';

/** Server-owned account/profile inputs only; never client verification flags. */
export function isEligibleSocialGuest(
  user: PlatformUser | null,
  profile: GuestProfile | null,
): boolean {
  return Boolean(
    user &&
    profile &&
    user.id === profile.userId &&
    user.role === 'guest' &&
    user.emailVerified &&
    isGuestOnboardingComplete(profile),
  );
}
