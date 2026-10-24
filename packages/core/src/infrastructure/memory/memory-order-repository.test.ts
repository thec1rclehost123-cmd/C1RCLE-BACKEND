import { describe, expect, it } from 'vitest';

import { calculatePricing } from '../../domain/models/pricing.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createOrder } from '../../domain/models/order.js';

import { MemoryOrderRepository } from './memory-repositories.js';

import type { Order } from '../../domain/models/order.js';

function order(id: string, createdAt: string): Order {
  const now = new Date(createdAt);
  const tier = createTicketTier({
    id: `tier-${id}`,
    eventId: 'event-1',
    organizationId: 'org-1',
    name: 'General',
    priceInPaise: 10_000,
    quantity: 10,
    now,
  });
  return createOrder({
    id,
    eventId: 'event-1',
    organizationId: 'org-1',
    contact: { name: 'Test buyer', email: 'test@example.invalid', phone: '' },
    pricing: calculatePricing({ lines: [{ tier, quantity: 1 }] }),
    now,
  });
}

describe('MemoryOrderRepository.listByOrganization', () => {
  it('paginates newest-first independent of insertion order', async () => {
    const repository = new MemoryOrderRepository();
    await repository.save(order('order-old', '2026-10-20T10:00:00.000Z'));
    await repository.save(order('order-newest', '2026-10-22T10:00:00.000Z'));
    await repository.save(order('order-middle', '2026-10-21T10:00:00.000Z'));

    const firstPage = await repository.listByOrganization('org-1', { limit: 2, cursor: null });
    const secondPage = await repository.listByOrganization('org-1', {
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.items.map((item) => item.id)).toEqual(['order-newest', 'order-middle']);
    expect(firstPage.nextCursor).toBe('order-middle');
    expect(secondPage.items.map((item) => item.id)).toEqual(['order-old']);
  });
});
