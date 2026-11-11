import { describe, expect, it, vi } from 'vitest';

import { createEvent, transitionEvent } from '../../domain/models/event.js';

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

function service(input = event) {
  return new EventService({
    config: { features: {}, clock: { now: () => NOW } },
    repositories: { events: { getById: async () => input } },
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

describe('guest-facing copy before publication', () => {
  it('rejects publishing an event without a nonblank summary and description', async () => {
    const publicEvent = createEvent({
      id: 'public-no-copy',
      organizationId: 'host',
      venueId: 'venue',
      title: 'Public Event',
      startAt: '2026-11-28T20:00:00.000Z',
      now: NOW,
    });
    const reviewedEvent = transitionEvent(publicEvent, 'review', NOW);
    await expect(service(reviewedEvent).publish(owner, reviewedEvent.id)).rejects.toThrow(
      'Add a guest-facing summary and description before publishing',
    );
  });
});

describe('external location review gate', () => {
  const externalDraft = createEvent({
    id: 'external-draft',
    organizationId: 'host',
    venueId: null,
    externalLocation: {
      name: 'Independent Hall',
      address: '12 Example Road',
      city: 'Pune',
      contact: { managerName: 'Venue Manager', phone: '+91 98765 43210' },
      review: {
        status: 'pending',
        submittedAt: NOW.toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      },
    },
    title: 'External venue event',
    summary: 'A guest-facing summary.',
    description: 'A guest-facing event description with sufficient detail.',
    startAt: '2026-11-28T20:00:00.000Z',
    now: NOW,
  });

  it('keeps pending external-location events out of publication review and publishing', async () => {
    await expect(service(externalDraft).review(owner, externalDraft.id)).rejects.toThrow(
      'C1RCLE must approve the external venue',
    );
    await expect(service(externalDraft).publish(owner, externalDraft.id)).rejects.toThrow(
      'C1RCLE must approve the external venue',
    );
  });

  it('creates an external-location event without creating a Venue or requiring a slot request', async () => {
    const save = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const service = new EventService({
      config: { features: {}, clock: { now: () => NOW }, ids: () => 'external-created' },
      repositories: {
        events: { save },
        venues: {
          getById: vi.fn(async () => {
            throw new Error('Venue lookup must be skipped');
          }),
        },
      },
      outbox: { append },
    } as never);
    const event = await service.create(
      { userId: 'host-user', organizationId: 'host', role: 'owner', capabilities: ['host'] },
      {
        venueId: null,
        externalLocation: {
          name: 'Independent Hall',
          address: '12 Example Road',
          contact: { managerName: 'Venue Manager', phone: '+91 98765 43210' },
        },
        title: 'External venue event',
        startAt: '2026-11-28T20:00:00.000Z',
      },
    );
    expect(event.venueId).toBeNull();
    expect(event.externalLocation?.review.status).toBe('pending');
    expect(save).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
  });

  it('allows only the owning Host to resubmit a rejected location into a fresh pending review', async () => {
    const originalLocation = externalDraft.externalLocation;
    if (!originalLocation) throw new Error('Expected external location fixture');
    const rejected = {
      ...externalDraft,
      externalLocation: {
        ...originalLocation,
        review: {
          status: 'rejected' as const,
          submittedAt: NOW.toISOString(),
          reviewedAt: NOW.toISOString(),
          reviewedBy: 'ops',
          rejectionReason: 'Provide venue authorization.',
        },
      },
    };
    const save = vi.fn(async () => undefined);
    const service = new EventService({
      config: { features: {}, clock: { now: () => NOW } },
      repositories: { events: { getById: async () => rejected, save } },
    } as never);
    const updated = await service.resubmitExternalLocation(
      { userId: 'host-user', organizationId: 'host', role: 'owner', capabilities: ['host'] },
      rejected.id,
      {
        name: 'Independent Hall Annex',
        address: '15 Example Road',
        contact: { managerName: 'New Manager', phone: '+91 98765 11111' },
      },
    );
    expect(updated.externalLocation).toMatchObject({
      name: 'Independent Hall Annex',
      review: { status: 'pending', reviewedBy: null, rejectionReason: null },
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it('allows an external-location Host to reschedule without a Venue slot', async () => {
    const save = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const service = new EventService({
      config: { features: {}, clock: { now: () => NOW } },
      repositories: { events: { getById: async () => externalDraft, save } },
      outbox: { append },
    } as never);
    const updated = await service.update(
      { userId: 'host-user', organizationId: 'host', role: 'owner', capabilities: ['host'] },
      {
        eventId: externalDraft.id,
        expectedVersion: null,
        changes: {
          startAt: '2026-12-01T20:00:00.000Z',
          endAt: '2026-12-02T00:00:00.000Z',
        },
      },
    );
    expect(updated).toMatchObject({
      venueId: null,
      startAt: '2026-12-01T20:00:00.000Z',
      endAt: '2026-12-02T00:00:00.000Z',
    });
    expect(save).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
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
    expect(save).toHaveBeenCalledWith(
      updated,
      null,
      expect.objectContaining({ type: 'event.updated', aggregateId: updated.id }),
    );
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
    expect(save).toHaveBeenCalledWith(
      updated,
      null,
      expect.objectContaining({ type: 'event.updated', aggregateId: updated.id }),
    );
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
    expect(save).toHaveBeenCalledWith(
      updated,
      null,
      expect.objectContaining({ type: 'event.updated', aggregateId: updated.id }),
    );
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
