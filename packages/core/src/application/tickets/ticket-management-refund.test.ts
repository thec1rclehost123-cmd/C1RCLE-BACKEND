import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent } from '../../domain/models/event.js';
import { createOrder } from '../../domain/models/order.js';
import { calculatePricing } from '../../domain/models/pricing.js';
import { createRefundRequest } from '../../domain/models/refund-request.js';
import { MemoryRefundRequestRepository } from '../../infrastructure/memory/memory-refund-request-repository.js';
import {
  MemoryEntitlementRepository,
  MemoryEventRepository,
  MemoryOrderRepository,
} from '../../infrastructure/memory/memory-repositories.js';

import { managedTicketRow } from './ticket-management.js';

import type { ServiceDeps } from '../context.js';

const now = new Date('2026-11-04T23:00:00.000Z');
async function fixture(scope: 'ticket_lines' | 'amount_only' = 'ticket_lines') {
  const events = new MemoryEventRepository();
  const orders = new MemoryOrderRepository();
  const entitlements = new MemoryEntitlementRepository();
  const refundRequests = new MemoryRefundRequestRepository();
  const event = {
    ...createEvent({
      id: 'event-refund-management',
      organizationId: 'org-refund',
      venueId: 'venue-refund',
      title: 'Refund management',
      startAt: '2026-11-04T22:00:00.000Z',
      endAt: '2026-11-05T02:00:00.000Z',
      now,
    }),
    status: 'published' as const,
  };
  await events.save(event);
  const tier = createTicketTier({
    id: 'tier-shared',
    eventId: event.id,
    organizationId: event.organizationId,
    name: 'General',
    quantity: 10,
    priceInPaise: 100000,
    now,
  });
  const order = {
    ...createOrder({
      id: 'order-refund-management',
      eventId: event.id,
      organizationId: event.organizationId,
      userId: 'buyer',
      contact: { name: 'Buyer', email: '', phone: '' },
      pricing: calculatePricing({ lines: [{ tier, quantity: 2 }] }),
      now,
    }),
    status: 'refund_requested' as const,
  };
  await orders.save(order);
  const tickets = issueEntitlements({ order: { ...order, status: 'paid' }, now });
  const selected = tickets[0];
  const second = tickets[1];
  if (!selected || !second) throw new Error('Two paid attendee fixtures are required');
  const unaffected = { ...second, currentHolderUserId: 'other-holder' };
  const request = createRefundRequest({
    id: 'refund-selected',
    orderId: order.id,
    organizationId: order.organizationId,
    amountPaise: 100000,
    requestedBy: 'admin',
    reason: 'One attendee refund',
    scope,
    ...(scope === 'ticket_lines'
      ? { targetEntitlementIds: [selected.id], ticketLines: [{ tierId: tier.id, quantity: 1 }] }
      : {}),
    hasRedeemedEntitlement: false,
    now,
  });
  await refundRequests.save(request);
  const deps = {
    config: createCoreConfig({
      clock: { now: () => now },
      firestore: { projectId: 'test-project' },
      redis: { url: 'redis://localhost:6379' },
    }),
    repositories: {
      events,
      orders,
      entitlements,
      refundRequests,
      eventCoverAccounts: { getByEntitlement: async () => null },
    },
  } as unknown as ServiceDeps;
  const read = (ticket: typeof selected, userId: string) =>
    managedTicketRow(deps, ticket, {
      userId,
      organizationId: '',
      role: 'member',
      capabilities: [],
    });
  return { request, selected, unaffected, read, refundRequests };
}

describe('ticket-scoped refund management', () => {
  it('withholds only the selected attendee while the same-order unaffected holder can still present', async () => {
    const { request, selected, unaffected, read } = await fixture();
    await expect(
      read(
        { ...selected, refundLock: { refundRequestId: request.id, frozenAt: now.toISOString() } },
        'buyer',
      ),
    ).resolves.toMatchObject({ status: 'refund_pending', canPresent: false, canTransfer: false });
    await expect(read(unaffected, 'other-holder')).resolves.toMatchObject({
      status: 'active',
      ownership: 'you',
      canPresent: true,
    });
  });

  it('uses persisted exact selection if request persistence precedes the selected ticket freeze', async () => {
    const { selected, unaffected, read } = await fixture();
    await expect(read(selected, 'buyer')).resolves.toMatchObject({
      status: 'refund_pending',
      canPresent: false,
    });
    await expect(read(unaffected, 'other-holder')).resolves.toMatchObject({
      status: 'active',
      canPresent: true,
    });
  });

  it('preserves a canonical per-ticket lock even when its request is no longer pending', async () => {
    const { request, selected, read, refundRequests } = await fixture();
    refundRequests.requests.set(request.id, { ...request, status: 'rejected' });
    await expect(
      read(
        { ...selected, refundLock: { refundRequestId: request.id, frozenAt: now.toISOString() } },
        'buyer',
      ),
    ).resolves.toMatchObject({ status: 'refund_pending', canPresent: false });
  });

  it('retains whole-order presentation locks for amount-only refunds', async () => {
    const { unaffected, read } = await fixture('amount_only');
    await expect(read(unaffected, 'other-holder')).resolves.toMatchObject({
      status: 'refund_pending',
      canPresent: false,
    });
  });

  it.each(['missing-request', 'missing-selection'] as const)(
    'fails closed for legacy %s refund metadata',
    async (state) => {
      const { request, unaffected, read, refundRequests } = await fixture();
      if (state === 'missing-request') refundRequests.requests.clear();
      else refundRequests.requests.set(request.id, { ...request, targetEntitlementIds: [] });
      await expect(read(unaffected, 'other-holder')).resolves.toMatchObject({
        status: 'refund_pending',
        canPresent: false,
      });
    },
  );
});
