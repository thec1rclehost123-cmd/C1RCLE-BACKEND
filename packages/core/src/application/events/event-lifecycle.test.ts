import { describe, expect, it, vi } from 'vitest';

import { createEvent } from '../../domain/models/event.js';

import { EventService } from './event-service.js';

import type { DomainEvent } from '../../domain/events.js';
import type { Event } from '../../domain/models/event.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const owner = { userId: 'owner', organizationId: 'host', capabilities: [], role: 'owner' as const };
const initial: Event = {
  ...createEvent({
    id: 'night',
    organizationId: 'host',
    venueId: 'venue',
    title: 'Night',
    startAt: '2026-11-10T20:00:00.000Z',
    endAt: '2026-11-11T02:00:00.000Z',
    now: NOW,
  }),
  status: 'published',
  isPublic: true,
};
function setup(event: Event = initial) {
  let stored = event;
  const append = vi.fn(async (_event: DomainEvent) => undefined);
  const save = vi.fn(async (updated: Event) => {
    stored = updated;
  });
  const service = new EventService({
    config: { clock: { now: () => NOW }, features: {} },
    repositories: { events: { getById: async () => stored, save } },
    outbox: { append },
  } as never);
  return { service, append, save, read: () => stored };
}

describe('M3 canonical lifecycle and durable remedy facts', () => {
  it('does not classify title corrections or shifts up to 12 hours as material', async () => {
    const { service, append } = setup();
    await service.update(owner, {
      eventId: initial.id,
      expectedVersion: 1,
      changes: {
        title: 'Corrected Night',
        startAt: '2026-11-11T08:00:00.000Z',
        endAt: '2026-11-11T14:00:00.000Z',
      },
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event.updated',
        payload: expect.objectContaining({ materialChange: null }),
      }),
    );
  });
  it('queues a material remedy fact for shifts greater than 12 hours', async () => {
    const { service, append, save } = setup();
    await service.update(owner, {
      eventId: initial.id,
      expectedVersion: 1,
      changes: { startAt: '2026-11-11T08:00:00.001Z', endAt: '2026-11-11T14:00:00.000Z' },
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          materialChange: expect.objectContaining({ previousStartAt: initial.startAt }),
        }),
      }),
    );
    expect(save).toHaveBeenCalledWith(expect.anything(), null, append.mock.calls[0]?.[0]);
  });
  it('retains dates/history while postponing and repairs the durable fact on retry', async () => {
    const { service, append, save } = setup();
    const postponed = await service.postpone(owner, initial.id, 'Venue unavailable');
    expect(postponed).toMatchObject({
      status: 'postponed',
      startAt: initial.startAt,
      isPublic: false,
      postponement: { initiatedBy: 'host', organizationId: 'host', reason: 'Venue unavailable' },
    });
    const firstFact = append.mock.calls[0]?.[0];
    await service.postpone(owner, initial.id, 'Venue unavailable');
    expect(save).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[1]?.[0]).toMatchObject({ id: firstFact?.id });
    expect(firstFact).toMatchObject({ payload: { materialChange: { changeType: 'postponed' } } });
  });
  it('requires explicit replacement-date rescheduling to unfreeze a postponed event', async () => {
    const { service, read, append } = setup({ ...initial, status: 'postponed', isPublic: false });
    await expect(service.publish(owner, initial.id)).rejects.toThrow('replacement date');
    await expect(service.resumeSales(owner, initial.id)).rejects.toThrow('replacement date');
    await expect(
      service.update(owner, {
        eventId: initial.id,
        expectedVersion: 1,
        resumePostponed: true,
        changes: {},
      }),
    ).rejects.toThrow('future replacement date');
    await service.update(owner, {
      eventId: initial.id,
      expectedVersion: 1,
      resumePostponed: true,
      changes: { startAt: '2026-11-12T20:00:00.000Z', endAt: '2026-11-13T02:00:00.000Z' },
    });
    expect(read()).toMatchObject({ status: 'published', version: 2, isPublic: true });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          title: 'Night',
          materialChange: expect.objectContaining({ changeType: 'rescheduled' }),
        },
      }),
    );
  });
  it('can cancel a postponed event and never resumes a cancelled event', async () => {
    const { service, read } = setup({ ...initial, status: 'postponed' });
    await service.cancel(owner, initial.id, 'Cancelled');
    expect(read().status).toBe('cancelled');
    await expect(service.resumeSales(owner, initial.id)).rejects.toThrow('terminal');
  });
});

it('announces the same future date after a resolved Venue freeze with exactly one version increment', async () => {
  const { service, read, save } = setup({ ...initial, status: 'postponed', isPublic: false });
  await service.update(owner, {
    eventId: initial.id,
    expectedVersion: 1,
    resumePostponed: true,
    changes: { startAt: initial.startAt, endAt: initial.endAt },
  });
  expect(read()).toMatchObject({ status: 'published', version: 2, startAt: initial.startAt });
  expect(save).toHaveBeenCalledOnce();
});
it('freezes and cancels an event that has already started', async () => {
  const postponed = setup({ ...initial, status: 'started' });
  expect((await postponed.service.postpone(owner, initial.id, 'Venue safety issue')).status).toBe(
    'postponed',
  );
  const cancelled = setup({ ...initial, status: 'started' });
  expect((await cancelled.service.cancel(owner, initial.id, 'Event stopped')).status).toBe(
    'cancelled',
  );
});
