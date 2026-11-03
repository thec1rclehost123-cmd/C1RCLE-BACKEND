import { describe, expect, it } from 'vitest';

import { createEvent } from '../../domain/models/event.js';

import { FirestoreEventRepository } from './firestore-event-repository.js';

import type { Firestore } from 'firebase-admin/firestore';

const media = {
  youtubeUrl: 'https://youtu.be/abc123',
  gallery: [{ url: 'https://example.test/gallery.jpg', alt: 'Dance floor' }],
  spotlights: [],
};
describe('event media persistence boundary', () => {
  it('hydrates saved media from a Firestore document', async () => {
    const event = createEvent({
      id: 'event-media',
      organizationId: 'org-1',
      venueId: 'venue-1',
      title: 'Media event',
      startAt: '2099-11-16T13:30:00Z',
      media,
    });
    const db = {
      collection: () => ({ doc: () => ({ get: () => Promise.resolve({ data: () => event }) }) }),
    } as unknown as Firestore;
    expect((await new FirestoreEventRepository(db).getById(event.id))?.media).toEqual(media);
  });
  it('rejects public image media for a restricted event', () => {
    expect(() =>
      createEvent({
        id: 'restricted-media',
        organizationId: 'org-1',
        venueId: 'venue-1',
        title: 'Private',
        startAt: '2099-11-16T13:30:00Z',
        media,
        visibilityMode: 'invited',
      }),
    ).toThrow('public or unlisted');
  });
});
