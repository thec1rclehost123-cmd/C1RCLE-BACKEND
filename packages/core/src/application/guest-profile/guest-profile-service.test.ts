import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from '../../domain/errors.js';
import { MemoryGuestProfileRepository } from '../../infrastructure/memory/memory-guest-profile-repository.js';

import { createGuestProfileService } from './guest-profile-service.js';

class FakeClock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
}

const INPUT = {
  displayName: 'Aayush',
  dateOfBirth: '2000-01-01',
  city: 'Pune',
  tastes: ['Rooftops', 'Live music', 'Art & culture'],
  intents: ['Find events'],
};

function build() {
  const clock = new FakeClock(new Date('2026-09-08T00:00:00.000Z'));
  const guestProfiles = new MemoryGuestProfileRepository();
  const service = createGuestProfileService({
    guestProfiles,
    config: { clock } as never,
  });
  return { service, guestProfiles };
}

describe('GuestProfileService', () => {
  it('returns null before any profile is saved', async () => {
    const { service } = build();
    await expect(service.getMine('user_1')).resolves.toBeNull();
  });

  it('creates then fully replaces the profile, preserving createdAt', async () => {
    const { service } = build();
    const created = await service.upsertMine('user_1', INPUT);
    expect(created.userId).toBe('user_1');
    expect(created.version).toBe(1);

    const updated = await service.upsertMine('user_1', { ...INPUT, city: 'Mumbai' });
    expect(updated.city).toBe('Mumbai');
    expect(updated.version).toBe(2);
    expect(updated.createdAt).toBe(created.createdAt);

    await expect(service.getMine('user_1')).resolves.toEqual(updated);
  });

  it('isolates profiles by user id', async () => {
    const { service } = build();
    await service.upsertMine('user_1', INPUT);
    await expect(service.getMine('user_2')).resolves.toBeNull();
  });

  it('rejects under-18 with InvalidOperationError', async () => {
    const { service } = build();
    await expect(
      service.upsertMine('user_1', { ...INPUT, dateOfBirth: '2015-01-01' }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(service.getMine('user_1')).resolves.toBeNull();
  });
  it.each(['2000-02-31', '2000-13-01', '2000-00-01', '2000-01-00'])(
    'rejects impossible calendar DOB %s without persisting it',
    async (dateOfBirth) => {
      const { service } = build();
      await expect(service.upsertMine('user_1', { ...INPUT, dateOfBirth })).rejects.toBeInstanceOf(
        InvalidOperationError,
      );
      await expect(service.getMine('user_1')).resolves.toBeNull();
    },
  );

  it('resumes partial fields and keeps verified phone through later progress saves', async () => {
    const { service } = build();
    await service.saveOnboarding('user_1', { displayName: 'Guest' });
    await service.saveOnboarding('user_1', { dateOfBirth: '2000-01-01' });
    await service.verifyPhone('user_1', '+919876543210', 'synthetic-proof', {
      name: 'capture-only',
      verify: async () => ({ passed: true, provider: 'firebase-phone' }),
    });
    const saved = await service.saveOnboarding('user_1', { tastes: ['House'] });
    expect(saved.displayName).toBe('Guest');
    expect(saved.dateOfBirth).toBe('2000-01-01');
    expect(saved.phoneVerifiedAt).toBeTruthy();
    expect((await service.getMine('user_1'))?.tastes).toEqual(['House']);
    expect(await service.getMine('user_2')).toBeNull();
  });
  it.each([
    { passed: false, provider: 'firebase-phone' },
    { passed: true, provider: 'format-check' },
  ])('does not trust failed or format-only phone proof %j', async (result) => {
    const { service } = build();
    await expect(
      service.verifyPhone('user_1', '+919876543210', 'synthetic-proof', {
        name: 'fixture',
        verify: async () => result,
      }),
    ).rejects.toThrow();
    expect(await service.getMine('user_1')).toBeNull();
  });
});

it('preserves authoritative verified phone and onboarding completion through a profile edit', async () => {
  const { service } = build();
  await service.saveOnboarding('profile-owner', {
    displayName: 'Synthetic Guest',
    dateOfBirth: '2000-01-01',
    tastes: ['House'],
  });
  await service.verifyPhone('profile-owner', '+919000000041', 'synthetic-proof', {
    name: 'fixture',
    verify: async () => ({ passed: true, provider: 'firebase-phone' }),
  });
  const before = await service.getMine('profile-owner');
  const after = await service.upsertMine('profile-owner', {
    displayName: 'Updated Guest',
    dateOfBirth: '2000-01-01',
    tastes: ['House'],
    city: '',
    intents: [],
  });
  expect(after.phoneNumber).toBe(before?.phoneNumber);
  expect(after.phoneVerifiedAt).toBe(before?.phoneVerifiedAt);
  expect((await service.getOnboarding('profile-owner')).complete).toBe(true);
  expect(await service.getMine('another-owner')).toBeNull();
});
