import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import {
  createSlotRequest,
  createVenueAvailabilitySlot,
  setVenueSlotRequestState,
  transitionSlotRequest,
} from '../../domain/models/venue.js';

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

  it('rolls back injected mid-transaction failure and replay converges atomically', async () => {
    const venueId = randomUUID();
    const hostId = randomUUID();
    const slot = createVenueAvailabilitySlot({
      id: randomUUID(),
      venueId,
      label: 'Atomic event slot',
      startTime: '2099-11-17T12:00:00.000Z',
      endTime: '2099-11-17T16:00:00.000Z',
      timezone: 'Asia/Kolkata',
      now: new Date('2099-01-01T00:00:00.000Z'),
    });
    const eventId = randomUUID();
    const request = createSlotRequest({
      id: randomUUID(),
      venueId,
      slotId: slot.id,
      eventId,
      hostId,
      eventDraft: {
        event: {
          venueId,
          title: 'Atomic event',
          startAt: '2099-11-17T13:00:00.000Z',
          endAt: '2099-11-17T15:00:00.000Z',
        },
        tiers: [],
        promotions: [],
        promoters: [],
      },
      now: new Date('2099-01-01T00:00:00.000Z'),
    });
    documents.push(
      ['v2_venue_slots', slot.id],
      ['v2_slot_requests', request.id],
      ['v2_events', eventId],
    );
    documents.push(['v2_event_catalog_tiers', 'tier-atomic']);
    const repository = new FirestoreSlotRequestRepository(db);
    await repository.createForOpenSlot(request, slot);
    const storedSlot = (await db.collection('v2_venue_slots').doc(slot.id).get()).data();
    if (!storedSlot) throw new Error('Expected the request slot to be pending');
    const acceptedRequest = transitionSlotRequest(
      request,
      'accepted',
      new Date('2099-01-01T00:00:00.000Z'),
    );
    const bookedSlot = setVenueSlotRequestState(
      storedSlot as unknown as typeof slot,
      'booked',
      request.id,
      hostId,
      new Date('2099-01-01T00:00:00.000Z'),
    );
    const draftEvent = createEvent({
      id: eventId,
      organizationId: hostId,
      venueId,
      title: 'Atomic event',
      summary: 'Atomic transaction test.',
      description: 'Atomic transaction test.',
      startAt: '2099-11-17T13:00:00.000Z',
      endAt: '2099-11-17T15:00:00.000Z',
      now: new Date('2099-01-01T00:00:00.000Z'),
    });
    const reviewed = transitionEvent(draftEvent, 'review', new Date('2099-01-01T00:00:00.000Z'));
    const publishedEvent = transitionEvent(
      { ...reviewed, status: 'scheduled' as const },
      'published',
      new Date('2099-01-01T00:00:00.000Z'),
    );
    const tier = createTicketTier({
      id: 'tier-atomic',
      eventId,
      organizationId: hostId,
      name: 'General',
      quantity: 10,
      priceInPaise: 1000,
      now: new Date('2099-01-01T00:00:00.000Z'),
    });
    const bundle = {
      previousRequest: request,
      acceptedRequest,
      bookedSlot,
      event: publishedEvent,
      tiers: [tier],
      promos: [],
      assignments: [],
    };

    const realDb = db;
    let createCalls = 0;
    const failureDb = new Proxy(realDb, {
      get(target, property) {
        if (property === 'runTransaction') {
          return (update: (tx: unknown) => Promise<unknown>) =>
            target.runTransaction((tx) => {
              const injected = new Proxy(tx, {
                get(transaction, key) {
                  if (key === 'create')
                    return (...args: Parameters<typeof tx.create>) => {
                      createCalls += 1;
                      if (createCalls === 2)
                        throw new Error('injected failure inside atomic commit');
                      return tx.create(...args);
                    };
                  const value = Reflect.get(transaction, key, transaction);
                  return typeof value === 'function' ? value.bind(transaction) : value;
                },
              });
              return update(injected);
            });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      new FirestoreSlotRequestRepository(failureDb).commitAcceptedEventBundle(bundle),
    ).rejects.toThrow('injected failure inside atomic commit');
    expect((await db.collection('v2_slot_requests').doc(request.id).get()).data()?.status).toBe(
      'pending',
    );
    expect((await db.collection('v2_venue_slots').doc(slot.id).get()).data()?.status).toBe(
      'pending',
    );
    expect((await db.collection('v2_events').doc(eventId).get()).exists).toBe(false);
    expect((await db.collection('v2_event_catalog_tiers').doc(tier.id).get()).exists).toBe(false);

    await expect(repository.commitAcceptedEventBundle(bundle)).resolves.toMatchObject({
      status: 'accepted',
    });
    await expect(repository.commitAcceptedEventBundle(bundle)).resolves.toMatchObject({
      status: 'accepted',
    });
    expect((await db.collection('v2_slot_requests').doc(request.id).get()).data()).toMatchObject({
      status: 'accepted',
      eventId,
    });
    expect((await db.collection('v2_venue_slots').doc(slot.id).get()).data()?.status).toBe(
      'booked',
    );
    expect((await db.collection('v2_events').doc(eventId).get()).data()).toMatchObject({
      status: 'published',
    });
    expect((await db.collection('v2_event_catalog_tiers').doc(tier.id).get()).exists).toBe(true);

    // Emulate a historical partial accept with every publication doc already
    // present but the availability window still held as pending.
    await db.collection('v2_venue_slots').doc(slot.id).update({ status: 'pending' });
    await repository.commitAcceptedEventBundle(bundle);
    expect((await db.collection('v2_venue_slots').doc(slot.id).get()).data()?.status).toBe(
      'booked',
    );
  }, 45_000);
});
