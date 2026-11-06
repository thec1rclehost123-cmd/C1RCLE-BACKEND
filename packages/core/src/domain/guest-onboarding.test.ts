import { describe, expect, it } from 'vitest';

import { isGuestOnboardingComplete, saveGuestOnboarding } from './models/guest-profile.js';

const now = new Date('2026-11-04T12:00:00Z');
describe('Guest onboarding progress', () => {
  it('persists coherent partial canonical fields without claiming completion', () => {
    const name = saveGuestOnboarding('guest', null, { displayName: ' Google Name ' }, now);
    expect(name.displayName).toBe('Google Name');
    expect(name.dateOfBirth).toBe('');
    expect(isGuestOnboardingComplete(name)).toBe(false);
    const dob = saveGuestOnboarding('guest', name, { dateOfBirth: '2000-02-29' }, now);
    expect(dob.displayName).toBe('Google Name');
    expect(dob.createdAt).toBe(name.createdAt);
    expect(dob.version).toBe(2);
    expect(isGuestOnboardingComplete(dob)).toBe(false);
  });
  it('requires verified phone as well as required profile fields', () => {
    const profile = saveGuestOnboarding(
      'guest',
      null,
      { displayName: 'Guest', dateOfBirth: '2000-01-01', tastes: ['House'] },
      now,
    );
    expect(isGuestOnboardingComplete(profile)).toBe(false);
    expect(isGuestOnboardingComplete({ ...profile, phoneNumber: '+919876543210' })).toBe(false);
    expect(
      isGuestOnboardingComplete({
        ...profile,
        phoneNumber: '+919876543210',
        phoneVerifiedAt: now.toISOString(),
      }),
    ).toBe(true);
  });
  it('rejects invalid DOB and unknown interests without changing saved progress', () => {
    const profile = saveGuestOnboarding('guest', null, { displayName: 'Guest' }, now);
    expect(() =>
      saveGuestOnboarding('guest', profile, { dateOfBirth: '2000-02-31' }, now),
    ).toThrow();
    expect(() => saveGuestOnboarding('guest', profile, { tastes: ['unlisted'] }, now)).toThrow();
    expect(profile.dateOfBirth).toBe('');
    expect(profile.tastes).toEqual([]);
  });
});
