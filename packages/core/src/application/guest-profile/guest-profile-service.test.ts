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
});
