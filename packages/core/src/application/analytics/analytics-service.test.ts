import { describe, expect, it, vi } from 'vitest';

import { AnalyticsService } from './analytics-service.js';

import type { Event } from '../../domain/models/event.js';
import type { Order } from '../../domain/models/order.js';
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

describe('AnalyticsService event booking heatmap', () => {
  const eventRecord = event('public');
  const baseOrder = (over: Partial<Order>): Order =>
    ({
      id: 'order_1',
      eventId: 'event_1',
      organizationId: 'org_1',
      userId: 'user_1',
      contact: { name: 'Synthetic', email: 'private@example.test', phone: '000' },
      status: 'paid',
      lines: [],
      currency: 'INR',
      grandTotalPaise: 100,
      refundedPaise: 0,
      createdAt: '2026-11-09T18:00:00.000Z',
      ...over,
    }) as Order;

  it('uses bookedAt with createdAt fallback, counts refunds and cancelled RSVP history, and zero-fills', async () => {
    const orders = [
      baseOrder({ id: 'paid-1' }),
      baseOrder({ id: 'refund-1', status: 'refunded', refundedPaise: 100 }),
      baseOrder({ id: 'RSVP-cancelled', status: 'cancelled', grandTotalPaise: 0 }),
      baseOrder({ id: 'failed-1', status: 'failed' }),
      baseOrder({ id: 'cancelled-paid', status: 'cancelled' }),
      baseOrder({
        id: 'paid-booked-at',
        createdAt: '2026-11-09T00:00:00.000Z',
        bookedAt: '2026-11-09T18:00:00.000Z',
      }),
    ];
    const listByEvent = vi.fn(async () => ({
      items: orders,
      total: orders.length,
      nextCursor: null,
    }));
    const svc = new AnalyticsService({
      repositories: {
        events: { getById: vi.fn(async () => eventRecord) },
        orders: { listByEvent },
      },
    } as unknown as ServiceDeps);

    const result = await svc.getEventBookingHeatmap(actor, 'event_1');
    expect(result.timeZone).toBe('Asia/Kolkata');
    expect(result.weekdays[0]?.hours[23]).toBe(4);
    expect(result.totalBookings).toBe(4);
    expect(result.complete).toBe(true);
    expect(result.weekdays).toHaveLength(7);
    expect(result.weekdays[0]?.hours).toHaveLength(24);
    expect(result.weekdays[1]?.hours.reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it('denies cross-tenant events and marks a capped scan incomplete', async () => {
    const denied = new AnalyticsService({
      repositories: {
        events: { getById: vi.fn(async () => ({ ...eventRecord, organizationId: 'org_other' })) },
      },
    } as unknown as ServiceDeps);
    await expect(denied.getEventBookingHeatmap(actor, 'event_1')).rejects.toThrow();

    const many = Array.from(
      { length: 1000 },
      (_, index) =>
        ({
          id: `order-${String(index)}`,
          eventId: 'event_1',
          status: 'paid',
          bookedAt: '2026-11-09T18:00:00.000Z',
          createdAt: '2026-11-09T18:00:00.000Z',
        }) as Order,
    );
    const listByEvent = vi.fn(async () => ({ items: many, total: 1001, nextCursor: 'next' }));
    const capped = new AnalyticsService({
      repositories: {
        events: { getById: vi.fn(async () => eventRecord) },
        orders: { listByEvent },
      },
    } as unknown as ServiceDeps);
    const result = await capped.getEventBookingHeatmap(actor, 'event_1');
    expect(result.totalBookings).toBe(1000);
    expect(result.complete).toBe(false);
    expect(listByEvent).toHaveBeenCalledTimes(1);
  });
});
