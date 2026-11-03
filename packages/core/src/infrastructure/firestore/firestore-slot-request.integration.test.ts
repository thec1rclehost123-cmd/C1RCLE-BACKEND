import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSlotRequest, createVenueAvailabilitySlot } from '../../domain/models/venue.js';

import { FirestoreSlotRequestRepository } from './firestore-slot-request-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Implicit Venue booking transactions (emulator)', () => {
  let db: Firestore;
  const documents: (readonly [string, string])[] = [];
  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle', ignoreUndefinedProperties: true });
  });
  afterAll(async () => {
    await Promise.all(
      documents.map(([collection, id]) => db.collection(collection).doc(id).delete()),
    );
    await db.terminate();
  });
  function booking(
    venueId: string,
    startTime: string,
    endTime: string,
    slotId: string = randomUUID(),
  ) {
    const slot = createVenueAvailabilitySlot({
      id: slotId,
      venueId,
      label: 'Requested time',
      startTime,
      endTime,
      timezone: 'Asia/Kolkata',
      now: new Date('2026-01-01'),
    });
    const request = createSlotRequest({
      id: randomUUID(),
      venueId,
      slotId,
      eventId: null,
      hostId: randomUUID(),
      slotStartTime: startTime,
      slotEndTime: endTime,
      timezone: 'Asia/Kolkata',
      now: new Date('2026-01-01'),
    });
    documents.push(['v2_venue_slots', slotId], ['v2_slot_requests', request.id]);
    return { slot, request };
  }
  it('does not reopen an existing pending slot through an implicit-slot retry', async () => {
    const repository = new FirestoreSlotRequestRepository(db);
    const first = booking(randomUUID(), '2099-11-16T13:30:00Z', '2099-11-16T18:30:00Z');
    await repository.createForOpenSlot(first.request, first.slot);
    const second = booking(
      first.slot.venueId,
      first.slot.startTime,
      first.slot.endTime,
      first.slot.id,
    );
    await expect(repository.createForOpenSlot(second.request, second.slot)).rejects.toThrow(
      'no longer open',
    );
    expect(
      (await db.collection('v2_venue_slots').doc(first.slot.id).get()).data()?.slotRequestId,
    ).toBe(first.request.id);
    expect(await repository.getById(second.request.id)).toBeNull();
  }, 45_000);
  it('allows only one concurrent overlapping request, including across midnight IST', async () => {
    const repository = new FirestoreSlotRequestRepository(db);
    const venueId = randomUUID();
    const first = booking(venueId, '2099-11-16T16:30:00Z', '2099-11-16T20:30:00Z');
    const second = booking(venueId, '2099-11-16T19:30:00Z', '2099-11-16T21:30:00Z');
    const results = await Promise.allSettled([
      repository.createForOpenSlot(first.request, first.slot),
      repository.createForOpenSlot(second.request, second.slot),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  }, 45_000);
  it('permits adjacent intervals', async () => {
    const repository = new FirestoreSlotRequestRepository(db);
    const venueId = randomUUID();
    const first = booking(venueId, '2099-11-16T13:30:00Z', '2099-11-16T18:30:00Z');
    const next = booking(venueId, '2099-11-16T18:30:00Z', '2099-11-16T20:30:00Z');
    await repository.createForOpenSlot(first.request, first.slot);
    await expect(repository.createForOpenSlot(next.request, next.slot)).resolves.toBeUndefined();
  }, 45_000);
});
