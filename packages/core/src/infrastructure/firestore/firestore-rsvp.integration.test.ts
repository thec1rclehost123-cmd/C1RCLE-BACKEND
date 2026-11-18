import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { rsvpOrderId } from '../../application/checkout/checkout-service.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent } from '../../domain/models/event.js';
import { createOrder } from '../../domain/models/order.js';
import { calculatePricing } from '../../domain/models/pricing.js';

import { FirestoreOrderRepository } from './firestore-order-repository.js';

import type { Order } from '../../domain/models/order.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(EMULATOR)('M3 atomic RSVP (Firestore Emulator)', () => {
  async function fixture() {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const id = randomUUID();
    const now = new Date();
    const event = {
      ...createEvent({
        id: `rsvp-event-${id}`,
        organizationId: 'org-rsvp',
        venueId: 'venue-rsvp',
        title: 'RSVP race',
        startAt: new Date(now.getTime() + 3600000).toISOString(),
        now,
      }),
      status: 'published' as const,
    };
    const tier = createTicketTier({
      id: `rsvp-tier-${id}`,
      eventId: event.id,
      organizationId: event.organizationId,
      name: 'Free RSVP',
      accessType: 'RSVP',
      quantity: 1,
      now,
    });
    await db.collection('v2_events').doc(event.id).set(event);
    await db.collection('v2_event_catalog_tiers').doc(tier.id).set(tier);
    const repo = new FirestoreOrderRepository(db);
    const acquire = (userId: string, attempt = 0) => {
      const orderId = rsvpOrderId(event.id, userId, attempt);
      const order: Order = {
        ...createOrder({
          id: orderId,
          eventId: event.id,
          organizationId: event.organizationId,
          userId,
          contact: { name: userId, email: '', phone: '' },
          pricing: calculatePricing({ lines: [{ tier, quantity: 1 }] }),
          now,
        }),
        status: 'paid',
        paymentId: orderId,
        paidAt: now.toISOString(),
      };
      return repo.acquireRsvp({
        order,
        entitlements: issueEntitlements({ order, now }),
        now,
        expectedEventVersion: event.version,
        expectedTierVersion: tier.version,
      });
    };
    return { db, event, tier, now, repo, acquire };
  }

  it('commits exactly one order and ticket for simultaneous different accounts, and replays the winner', async () => {
    const { db, event, acquire } = await fixture();
    try {
      const results = await Promise.allSettled(
        ['guest-a', 'guest-b'].map((userId) => acquire(userId)),
      );
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      if (winner.status !== 'fulfilled') throw new Error('Missing winner');
      const replay = await acquire(winner.value.order.userId!);
      expect(replay.entitlements.map((ticket) => ticket.id)).toEqual(
        winner.value.entitlements.map((ticket) => ticket.id),
      );
      expect((await db.collection('v2_orders').where('eventId', '==', event.id).get()).size).toBe(
        1,
      );
      expect(
        (await db.collection('v2_entitlements').where('eventId', '==', event.id).get()).size,
      ).toBe(1);
    } finally {
      await db.terminate();
    }
  }, 30000);

  it('converges simultaneous rebookings after cancellation on one new valid ticket', async () => {
    const { db, event, repo, acquire, now } = await fixture();
    try {
      const first = await acquire('guest-a');
      await repo.cancelRsvp(first.order.id, 'guest-a', now);
      const [second, retry] = await Promise.all([acquire('guest-a', 1), acquire('guest-a', 1)]);
      expect(second.order.id).not.toBe(first.order.id);
      expect(retry.order.id).toBe(second.order.id);
      expect(retry.entitlements.map((ticket) => ticket.id)).toEqual(
        second.entitlements.map((ticket) => ticket.id),
      );
      const orders = await db.collection('v2_orders').where('eventId', '==', event.id).get();
      expect(orders.docs.map((doc) => doc.data().status).sort()).toEqual(['cancelled', 'paid']);
      const tickets = await db.collection('v2_entitlements').where('eventId', '==', event.id).get();
      expect(tickets.docs.map((doc) => doc.data().status).sort()).toEqual(['valid', 'void']);
    } finally {
      await db.terminate();
    }
  }, 30000);

  it('serializes cancellation against another acquisition without overselling or double release', async () => {
    const { db, repo, acquire, now, event } = await fixture();
    try {
      const first = await acquire('guest-a');
      const results = await Promise.allSettled([
        repo.cancelRsvp(first.order.id, 'guest-a', now),
        acquire('guest-b'),
      ]);
      expect(results[0]?.status).toBe('fulfilled');
      await repo.cancelRsvp(first.order.id, 'guest-a', now);
      if (results[1]?.status === 'rejected') await acquire('guest-b');
      const orders = await db.collection('v2_orders').where('eventId', '==', event.id).get();
      expect(orders.docs.filter((doc) => doc.data().status === 'paid')).toHaveLength(1);
      const tickets = await db.collection('v2_entitlements').where('eventId', '==', event.id).get();
      expect(tickets.docs.filter((doc) => doc.data().status === 'valid')).toHaveLength(1);
      expect(
        tickets.docs.find((doc) => doc.data().orderId === first.order.id)?.data(),
      ).toMatchObject({ status: 'void', credentialVersion: 2 });
    } finally {
      await db.terminate();
    }
  }, 30000);
});
