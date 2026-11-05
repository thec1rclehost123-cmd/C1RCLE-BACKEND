import { beforeEach, expect, it } from 'vitest';

import { createEvent } from '../../domain/models/event.js';
import { createGuestProfile } from '../../domain/models/guest-profile.js';
import { MemorySavedEventRepository } from '../../infrastructure/memory/memory-saved-event-repository.js';
import { type MemoryUserAccountRepository } from '../../infrastructure/memory/memory-user-account-repository.js';
import { buildRepositories } from '../../infrastructure/utils.js';

import { SavedEventService } from './saved-event-service.js';

const repos = buildRepositories({ STORAGE_DRIVER: 'memory', FIRESTORE_PROJECT_ID: 'synthetic' });
const event = {
  ...createEvent({
    id: 'event-a',
    organizationId: 'org-a',
    venueId: 'synthetic-venue',
    title: 'Synthetic Night',
    startAt: '2099-12-01T18:00:00Z',
  }),
  status: 'published' as const,
  isPublic: true,
};
let saved: MemorySavedEventRepository;
let service: SavedEventService;
beforeEach(async () => {
  saved = new MemorySavedEventRepository();
  service = new SavedEventService({
    repositories: repos,
    saved,
    readEvent: async () => ({ event }),
    now: () => new Date('2026-11-04T00:00:00Z'),
  });
  for (const id of ['guest-a', 'guest-b', 'partner']) {
    (repos.users as MemoryUserAccountRepository).save({
      id,
      email: `${id}@example.invalid`,
      image: null,
      name: id,
      role: id === 'partner' ? 'partner' : 'guest',
      emailVerified: true,
      createdAt: 0,
      updatedAt: 0,
    });
    await repos.guestProfiles.save({
      ...createGuestProfile(id, {
        displayName: id,
        dateOfBirth: '2000-01-01',
        tastes: ['House'],
        city: '',
        intents: [],
      }),
      phoneNumber: '+919000000041',
      phoneVerifiedAt: '2026-11-04T00:00:00Z',
    });
  }
});
it('converges repeated save/unsave without duplicates or social attendance', async () => {
  await Promise.all(Array.from({ length: 8 }, () => service.set('guest-a', 'event-a', true)));
  expect((await service.list('guest-a')).items).toHaveLength(1);
  expect(await service.state('guest-b', 'event-a')).toEqual({ saved: false });
  expect((await service.list('guest-b')).items).toEqual([]);
  expect((await repos.entitlements.listByEvent('event-a', { limit: 20 })).items).toEqual([]);
  await service.set('guest-a', 'event-a', false);
  await service.set('guest-a', 'event-a', false);
  expect((await service.list('guest-a')).items).toEqual([]);
});
it('denies non-Guest and missing identities', async () => {
  for (const id of ['partner', 'missing'])
    await expect(service.list(id)).rejects.toThrow('Guest account');
});
it('paginates a private bookmark list without duplicates', async () => {
  for (let i = 0; i < 23; i++)
    await saved.save('guest-a', `event-${String(i).padStart(2, '0')}`, '2026-11-04T00:00:00Z');
  const first = await saved.list('guest-a');
  expect(first.items).toHaveLength(20);
  if (!first.nextCursor) throw new Error('Expected another page');
  const next = await saved.list('guest-a', first.nextCursor);
  expect(next.items).toHaveLength(3);
  expect(next.nextCursor).toBeNull();
  expect(new Set([...first.items, ...next.items].map((row) => row.eventId)).size).toBe(23);
});
