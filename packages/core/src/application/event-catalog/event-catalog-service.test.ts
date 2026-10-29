import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createPromoterAssignment } from '../../domain/models/event-catalog.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { MemoryEventCatalogRepository } from '../../infrastructure/memory/memory-repositories.js';

import { EventCatalogService } from './event-catalog-service.js';

import type { ServiceDeps } from '../context.js';

describe('Promoter assignment expiry worker', () => {
  it('transitions due assignments once and emits one deterministic event', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() - 60_000).toISOString();
    const futureExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    const catalog = new MemoryEventCatalogRepository();
    const dueAssignment = createPromoterAssignment({
      id: 'assignment_due',
      eventId: 'event_1',
      promoterId: 'promoter_1',
      terms: { version: 1, ratePercent: 10, flatPaise: 0 },
      status: 'accepted',
      expiresAt,
      now: new Date('2026-10-28T00:00:00.000Z'),
    });
    const futureAssignment = createPromoterAssignment({
      id: 'assignment_future',
      eventId: 'event_1',
      promoterId: 'promoter_1',
      terms: { version: 1, ratePercent: 10, flatPaise: 0 },
      status: 'accepted',
      expiresAt: futureExpiresAt,
      now: new Date('2026-10-28T00:00:00.000Z'),
    });
    await catalog.saveAssignment(dueAssignment);
    await catalog.saveAssignment(futureAssignment);
    const outbox = new MemoryOutboxStore();
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
        clock: { now: () => now },
      }),
      outbox,
      repositories: {
        catalog,
        events: {
          getById: async () => ({ id: 'event_1', organizationId: 'host_1', title: 'Sky Night' }),
        },
      },
    } as unknown as ServiceDeps;
    const service = new EventCatalogService(deps);

    expect(await service.expireDuePromoterAssignments()).toBe(1);
    expect(await service.expireDuePromoterAssignments()).toBe(0);
    expect(await catalog.getAssignmentById(dueAssignment.id)).toMatchObject({
      status: 'expired',
      version: dueAssignment.version + 1,
    });
    expect(await catalog.getAssignmentById(futureAssignment.id)).toMatchObject({
      status: 'accepted',
    });
    const events = await outbox.listPending();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'promoter.assignment.expired',
      aggregateId: dueAssignment.id,
      payload: {
        id: events[0]?.id,
        type: 'promoter.assignment.expired',
        organizationId: 'host_1',
        actorId: 'system',
        payload: {
          assignmentId: dueAssignment.id,
          eventId: 'event_1',
          promoterId: 'promoter_1',
          eventTitle: 'Sky Night',
          expiresAt,
        },
      },
    });
  });
});
