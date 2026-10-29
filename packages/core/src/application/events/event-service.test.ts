import { describe, expect, it, vi } from 'vitest';

import { createEvent } from '../../domain/models/event.js';

import { EventService } from './event-service.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const event = createEvent({
  id: 'private-event',
  organizationId: 'host',
  venueId: 'venue',
  title: 'Private Event',
  startAt: '2026-11-28T20:00:00.000Z',
  visibilityMode: 'code',
  now: NOW,
});

function service() {
  return new EventService({
    config: { features: {}, clock: { now: () => NOW } },
    repositories: { events: { getById: async () => event } },
  } as never);
}

const owner = {
  userId: 'host-user',
  organizationId: 'host',
  role: 'owner' as const,
  capabilities: [],
};

describe('private event feature gate', () => {
  it('does not create a private event when private access is disabled', async () => {
    await expect(
      service().create(owner, {
        venueId: 'venue',
        title: 'Private Create',
        startAt: '2026-11-28T20:00:00.000Z',
        visibilityMode: 'code',
      }),
    ).rejects.toThrow('Private event access is not enabled');
  });

  it('rejects after-grant address disclosure for a public event', async () => {
    await expect(
      service().create(owner, {
        venueId: 'venue',
        title: 'Public Address Policy',
        startAt: '2026-11-28T20:00:00.000Z',
        visibilityMode: 'public',
        addressDisclosure: 'after_grant',
      }),
    ).rejects.toThrow('After-grant address disclosure requires a private event');
  });

  it('does not let a deployment without private access switch an event to private', async () => {
    await expect(
      service().update(owner, {
        eventId: event.id,
        expectedVersion: null,
        changes: { visibilityMode: 'invited' },
      }),
    ).rejects.toThrow('Private event access is not enabled');
  });

  it('does not publish a private event when private access is disabled', async () => {
    await expect(service().publish(owner, event.id)).rejects.toThrow(
      'Private event access is not enabled',
    );
  });
});

describe('private event poster privacy', () => {
  const publicEvent = createEvent({
    id: 'public-event',
    organizationId: 'host',
    venueId: 'venue',
    title: 'Public Event',
    imageUrl: 'https://storage.googleapis.com/c1rcle-test/posters/host/poster.webp',
    startAt: '2026-11-28T20:00:00.000Z',
    visibilityMode: 'public',
    now: NOW,
  });

  function eventService(
    revokePublicRead: (url: string, expectedKeyPrefix: string) => Promise<string | null>,
  ) {
    const save = vi.fn(async () => undefined);
    const objectStorage = {
      name: 'test-storage',
      revokePublicRead,
    };
    const instance = new EventService({
      config: {
        features: { m5PrivateAccess: true },
        clock: { now: () => NOW },
        ids: () => 'event-updated',
      },
      logger: { info: () => undefined },
      objectStorage,
      outbox: { append: async () => undefined },
      repositories: { events: { getById: async () => publicEvent, save } },
    } as never);
    return { instance, save };
  }

  it('revokes a managed poster before saving a public event as private', async () => {
    const revokePublicRead = vi.fn(async () => 'posters/host/poster.webp');
    const { instance, save } = eventService(revokePublicRead);

    const updated = await instance.update(owner, {
      eventId: publicEvent.id,
      expectedVersion: null,
      changes: { visibilityMode: 'code' },
    });

    expect(revokePublicRead).toHaveBeenCalledWith(publicEvent.imageUrl, 'posters/host/');
    expect(updated.visibilityMode).toBe('code');
    expect(updated.imageUrl).toBeNull();
    expect(updated.privateImageStoragePath).toBe('posters/host/poster.webp');
    expect(save).toHaveBeenCalledWith(updated);
  });

  it('keeps private activation closed for an unowned or external poster URL', async () => {
    const revokePublicRead = vi.fn(async () => null);
    const { instance, save } = eventService(revokePublicRead);

    await expect(
      instance.update(owner, {
        eventId: publicEvent.id,
        expectedVersion: null,
        changes: { visibilityMode: 'invited' },
      }),
    ).rejects.toThrow('managed storage so public access can be revoked');

    expect(revokePublicRead).toHaveBeenCalledWith(publicEvent.imageUrl, 'posters/host/');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('Host event rescheduling', () => {
  const hostEvent = createEvent({
    id: 'host-event',
    organizationId: 'host',
    venueId: 'venue',
    title: 'Host Event',
    startAt: '2026-11-28T20:00:00.000Z',
    endAt: '2026-11-28T23:00:00.000Z',
    now: NOW,
  });
  const hostActor = { ...owner, capabilities: ['host'] as const };
  const acceptedRequest = {
    id: 'accepted-slot-request',
    venueId: 'venue',
    slotId: 'approved-slot',
    eventId: hostEvent.id,
    hostId: 'host',
    status: 'accepted' as const,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  const slot = {
    id: 'approved-slot',
    venueId: 'venue',
    startTime: '2026-11-28T18:00:00.000Z',
    endTime: '2026-11-29T01:00:00.000Z',
    status: 'booked',
    slotRequestId: acceptedRequest.id,
    requestingHostId: 'host',
  };

  function hostEventService(
    input: {
      request?: typeof acceptedRequest | null;
      slot?: typeof slot | null;
      requests?: (typeof acceptedRequest)[];
      slots?: (typeof slot)[];
    } = {},
  ) {
    const save = vi.fn(async () => undefined);
    const transitionForSlot = vi.fn(async () => undefined);
    const requests =
      input.requests ?? (input.request === null ? [] : [input.request ?? acceptedRequest]);
    const slots =
      input.slots ?? [input.slot === null ? null : (input.slot ?? slot)].filter(Boolean);
    const instance = new EventService({
      config: { ids: () => 'test-event-outbox-id', clock: { now: () => NOW } },
      outbox: { append: async () => undefined },
      repositories: {
        events: { getById: async () => hostEvent, save },
        slotRequests: {
          listByHost: async () => ({
            items: requests,
            nextCursor: null,
          }),
          transitionForSlot,
        },
        venueSlots: {
          getSlotById: async (id: string) => slots.find((item) => item?.id === id) ?? null,
        },
        partnerships: { findByPair: async () => ({ status: 'active' }) },
        venues: { getById: async (id: string) => ({ id, status: 'active' }) },
      },
    } as never);
    return { instance, save, transitionForSlot };
  }

  it('allows a schedule adjustment that remains inside the accepted Venue slot', async () => {
    const { instance, save } = hostEventService();

    const updated = await instance.update(hostActor, {
      eventId: hostEvent.id,
      expectedVersion: null,
      changes: { startAt: '2026-11-28T21:00:00.000Z' },
    });

    expect(updated.startAt).toBe('2026-11-28T21:00:00.000Z');
    expect(save).toHaveBeenCalledWith(updated);
  });

  it('rejects moving a Host event outside its approved slot without saving', async () => {
    const { instance, save } = hostEventService();

    await expect(
      instance.update(hostActor, {
        eventId: hostEvent.id,
        expectedVersion: null,
        changes: { startAt: '2026-11-29T02:00:00.000Z' },
      }),
    ).rejects.toThrow('Host event timing must remain within its Venue-approved slot');
    expect(save).not.toHaveBeenCalled();
  });

  it('fails closed for legacy Host events without a current accepted slot', async () => {
    const { instance, save } = hostEventService({ request: null });

    await expect(
      instance.update(hostActor, {
        eventId: hostEvent.id,
        expectedVersion: null,
        changes: { startAt: '2026-11-28T21:00:00.000Z' },
      }),
    ).rejects.toThrow('A Host reschedule requires its active Venue-approved time slot');
    expect(save).not.toHaveBeenCalled();
  });

  it('does not treat an explicit removal of the end time as an unchanged schedule', async () => {
    const { instance, save } = hostEventService();

    await expect(
      instance.update(hostActor, {
        eventId: hostEvent.id,
        expectedVersion: null,
        changes: { endAt: null },
      }),
    ).rejects.toThrow('A Host reschedule requires its active Venue-approved time slot');
    expect(save).not.toHaveBeenCalled();
  });

  it('applies a Venue-approved replacement slot and releases the prior reservation after saving', async () => {
    const nextRequest = {
      ...acceptedRequest,
      id: 'accepted-slot-request-new',
      venueId: 'venue-new',
      slotId: 'approved-slot-new',
    };
    const nextSlot = {
      ...slot,
      id: 'approved-slot-new',
      venueId: 'venue-new',
      startTime: '2026-11-29T18:00:00.000Z',
      endTime: '2026-11-30T01:00:00.000Z',
      slotRequestId: nextRequest.id,
    };
    const { instance, save, transitionForSlot } = hostEventService({
      requests: [acceptedRequest, nextRequest],
      slots: [slot, nextSlot],
    });

    const updated = await instance.update(hostActor, {
      eventId: hostEvent.id,
      expectedVersion: null,
      changes: {
        venueId: 'venue-new',
        slotRequestId: nextRequest.id,
        startAt: '2026-11-29T20:00:00.000Z',
        endAt: '2026-11-29T23:00:00.000Z',
      },
    });

    expect(updated).toMatchObject({
      venueId: 'venue-new',
      startAt: '2026-11-29T20:00:00.000Z',
      endAt: '2026-11-29T23:00:00.000Z',
    });
    expect(save).toHaveBeenCalledWith(updated);
    expect(transitionForSlot).toHaveBeenCalledWith(
      acceptedRequest,
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('does not allow a direct Venue change without a Host-approved slot request', async () => {
    const { instance, save } = hostEventService();
    await expect(
      instance.update(owner, {
        eventId: hostEvent.id,
        expectedVersion: null,
        changes: { venueId: 'venue-unapproved' },
      }),
    ).rejects.toThrow('Only a Host can apply a Venue-approved slot request');
    expect(save).not.toHaveBeenCalled();
  });
});
