import { describe, expect, it, vi } from 'vitest';

import { AnalyticsService } from './analytics-service.js';

import type { Event } from '../../domain/models/event.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

function paged<T>(items: T[]) {
  return vi.fn(async (_query: PaginationQuery) => ({
    items,
    total: items.length,
    nextCursor: null,
  }));
}

function service(event: Event): AnalyticsService {
  return new AnalyticsService({
    repositories: {
      events: { listByOrganization: paged([event]) },
      orders: { listByOrganization: paged([]) },
      venues: { getById: vi.fn(async () => null) },
    },
  } as unknown as ServiceDeps);
}

const actor = {
  userId: 'user_1',
  organizationId: 'org_1',
  role: 'owner',
  capabilities: [],
} as unknown as ActorContext;

function event(visibilityMode: Event['visibilityMode']): Event {
  return {
    id: 'event_1',
    organizationId: 'org_1',
    venueId: null,
    title: 'Private event',
    startAt: '2099-01-01T00:00:00.000Z',
    endAt: null,
    status: 'published',
    visibilityMode,
    imageUrl: 'https://storage.googleapis.com/c1rcle/posters/org_1/legacy.webp',
  } as Event;
}

describe('AnalyticsService organization event cards', () => {
  it.each(['code', 'invited'] as const)(
    'redacts a legacy public poster URL from %s event cards',
    async (visibilityMode) => {
      const result = await service(event(visibilityMode)).getOrganizationEventCards(actor, 10);

      expect(result[0]?.imageUrl).toBeNull();
    },
  );

  it('preserves public event artwork', async () => {
    const result = await service(event('public')).getOrganizationEventCards(actor, 10);

    expect(result[0]?.imageUrl).toBe(
      'https://storage.googleapis.com/c1rcle/posters/org_1/legacy.webp',
    );
  });
});
