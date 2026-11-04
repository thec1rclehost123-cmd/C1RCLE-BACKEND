import { describe, expect, it, vi } from 'vitest';

import { MemorySupportTicketRepository } from '../../infrastructure/memory/memory-support-ticket-repository.js';

import { SupportService } from './support-service.js';

import type { ServiceDeps } from '../context.js';

function setup() {
  const supportTickets = new MemorySupportTicketRepository();
  const provider = vi.fn();
  const ordersSave = vi.fn();
  const deps = {
    config: { clock: { now: () => new Date('2026-11-04T12:00:00.000Z') } },
    paymentProvider: { refundPayment: provider },
    repositories: {
      supportTickets,
      users: { getById: async () => ({ emailVerified: true }) },
      orders: {
        getById: async () => ({
          id: 'order',
          userId: 'purchaser',
          eventId: 'event',
          status: 'paid',
          grandTotalPaise: 10_000,
          organizationId: 'host',
          createdAt: '2026-11-01T00:00:00.000Z',
        }),
        save: ordersSave,
      },
      entitlements: {
        getById: async (id: string) => ({
          id,
          orderId: 'order',
          eventId: 'event',
          status: 'valid',
          scanCount: 0,
          unitKind: 'paid',
        }),
      },
      events: {
        getById: async () => ({
          id: 'event',
          version: 2,
          title: 'Night',
          status: 'published',
          refundPolicy: { kind: 'organizer_reviewed' },
        }),
      },
    },
  } as unknown as ServiceDeps;
  return { service: new SupportService(deps), supportTickets, provider, ordersSave };
}
describe('durable ticket refund review intake', () => {
  it('stores exact attendee identity in the existing Admin support queue without moving money or locking the order', async () => {
    const { service, supportTickets, provider, ordersSave } = setup();
    const review = await service.requestTicketRefundReview(
      'purchaser',
      'riya',
      'Riya cannot attend',
    );
    expect(review.refundReview?.entitlementIds).toEqual(['riya']);
    expect(review.links).toMatchObject({
      orderId: 'order',
      eventId: 'event',
      organizationId: 'host',
    });
    expect(await supportTickets.getById(review.id)).toEqual(review);
    expect(provider).not.toHaveBeenCalled();
    expect(ordersSave).not.toHaveBeenCalled();
  });
  it('converges simultaneous submissions and never resets Admin progress on retry', async () => {
    const { service, supportTickets } = setup();
    const results = await Promise.all([
      service.requestTicketRefundReview('purchaser', 'riya', 'first'),
      service.requestTicketRefundReview('purchaser', 'riya', 'retry'),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(supportTickets.tickets.size).toBe(1);
    const original = results[0];
    await supportTickets.save({
      ...original,
      status: 'in_progress',
      version: original.version + 1,
    });
    expect(
      (await service.requestTicketRefundReview('purchaser', 'riya', 'retry later')).status,
    ).toBe('in_progress');
  });
  it('conceals another purchaser’s ticket', async () => {
    const { service, supportTickets } = setup();
    await expect(service.requestTicketRefundReview('stranger', 'riya', 'reason')).rejects.toThrow(
      'not found',
    );
    expect(supportTickets.tickets.size).toBe(0);
  });
});
