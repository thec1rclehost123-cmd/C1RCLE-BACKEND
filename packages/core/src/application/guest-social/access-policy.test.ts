import { describe, expect, it } from 'vitest';

import { createGuestProfile } from '../../domain/models/guest-profile.js';

import { isEligibleSocialGuest } from './access-policy.js';

import type { PlatformUser } from '../../domain/models/platform-user.js';

const user: PlatformUser = {
  id: 'guest-a',
  email: 'synthetic@example.invalid',
  name: 'Synthetic Guest',
  image: null,
  emailVerified: true,
  role: 'guest',
  createdAt: 0,
  updatedAt: 0,
};
const profile = {
  ...createGuestProfile(user.id, {
    displayName: 'Synthetic Guest',
    dateOfBirth: '2000-01-01',
    city: '',
    tastes: ['House'],
    intents: [],
  }),
  phoneNumber: '+919000000041',
  phoneVerifiedAt: '2026-11-04T00:00:00Z',
};

describe('founder-approved social audience', () => {
  it('requires a canonical verified account and completed profile owned by that account', () => {
    expect(isEligibleSocialGuest(user, profile)).toBe(true);
    expect(isEligibleSocialGuest(null, profile)).toBe(false);
    expect(isEligibleSocialGuest(user, null)).toBe(false);
    expect(isEligibleSocialGuest(user, { ...profile, userId: 'guest-b' })).toBe(false);
    expect(isEligibleSocialGuest({ ...user, emailVerified: false }, profile)).toBe(false);
    expect(isEligibleSocialGuest(user, { ...profile, phoneVerifiedAt: undefined })).toBe(false);
    expect(isEligibleSocialGuest(user, { ...profile, tastes: [] })).toBe(false);
  });
  it.each(['partner', 'admin', null])('does not broaden social access to role %s', (role) => {
    expect(isEligibleSocialGuest({ ...user, role }, profile)).toBe(false);
  });
});
