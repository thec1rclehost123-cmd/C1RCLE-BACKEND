import { randomUUID } from 'node:crypto';

import { Firestore, Transaction } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import { changeEntitlementHolder, issueEntitlements } from '../../domain/models/entitlement.js';
import { createEvent } from '../../domain/models/event.js';
import { createOrder } from '../../domain/models/order.js';
import { createRefundRequest } from '../../domain/models/refund-request.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';
import { FirestoreOrderRepository } from './firestore-order-repository.js';
import { FirestoreRefundRequestRepository } from './firestore-refund-request-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
async function fixture() {
  if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR))
    throw new Error('Refund intake regressions require loopback Firestore Emulator');
  const db = new Firestore({ projectId: `demo-m4-intake-${randomUUID().slice(0, 8)}` });
  const now = new Date();
  const orders = new FirestoreOrderRepository(db);
  const tickets = new FirestoreEntitlementRepository(db);
  const requests = new FirestoreRefundRequestRepository(db);
  const order = {
    ...createOrder({
      id: `ORD-${randomUUID()}`,
      eventId: `EVT-${randomUUID()}`,
      organizationId: 'ORG-local',
      userId: 'USR-local',
      contact: { name: 'Local Guest', email: 'local@example.test', phone: '+910000000000' },
      pricing: {
        currency: 'INR',
        lines: [
          {
            tierId: 'TIER-local',
            tierName: 'General',
            quantity: 2,
            unitPricePaise: 1000,
            subtotalPaise: 2000,
          },
        ],
        subtotalPaise: 2000,
        discountPaise: 0,
        discountedSubtotalPaise: 2000,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        gstPaise: 0,
        grandTotalPaise: 2000,
        appliedPromoCode: null,
      },
      now,
    }),
    status: 'paid' as const,
  };
  await orders.save(order);
  const event = {
    ...createEvent({
      id: order.eventId,
      organizationId: order.organizationId,
      venueId: 'VEN-local',
      title: 'Synthetic intake event',
      startAt: new Date(now.getTime() + 3600000).toISOString(),
    }),
    status: 'published' as const,
  };
  await db.collection('v2_events').doc(event.id).set(event);
  const entitlements = issueEntitlements({ order, now });
  await tickets.saveMany(entitlements);
  const selected = entitlements[0];
  if (!selected) throw new Error('Missing fixture ticket');
  const request = {
    ...createRefundRequest({
      id: `REF-${randomUUID()}`,
      orderId: order.id,
      organizationId: order.organizationId,
      amountPaise: 1000,
      requestedBy: 'ADMIN-local',
      reason: 'Synthetic intake regression',
      scope: 'ticket_lines',
      ticketLines: [{ tierId: selected.tierId, quantity: 1 }],
      targetEntitlementIds: [selected.id],
      hasRedeemedEntitlement: false,
      now,
    }),
    intakeFingerprint: 'synthetic-immutable-intent',
  };
  const input = {
    request,
    expectedOrderVersion: order.version,
    expectedEntitlementVersions: entitlements.map(({ id, version }) => ({ id, version })),
    now,
  };
  return {
    db,
    now,
    orders,
    tickets,
    requests,
    order,
    entitlements,
    selected,
    request,
    input,
    async cleanup() {
      for (const collection of [
        'v2_events',
        'v2_orders',
        'v2_entitlements',
        'v2_refund_requests',
        'v2_outbox',
        'v2_scan_ledger',
      ])
        await db.recursiveDelete(db.collection(collection));
      await db.terminate();
    },
  };
}

describe.runIf(EMULATOR)('M4 refund intake atomicity (native Firestore)', () => {
  it('atomically locks the order, creates the request and freezes only exact selected tickets; replay preserves progress', async () => {
    const f = await fixture();
    try {
      const first = await f.orders.beginRefundRequest(f.input);
      expect(first.order).toMatchObject({
        status: 'refund_requested',
        version: f.order.version + 1,
      });
      expect(await f.requests.getById(f.request.id)).toMatchObject(f.request);
      const selected = await f.tickets.getById(f.selected.id);
      expect(selected).toMatchObject({
        version: f.selected.version + 1,
        refundLock: { refundRequestId: f.request.id },
      });
      expect(
        (await f.tickets.getByOrderId(f.order.id)).filter((ticket) => ticket.refundLock),
      ).toHaveLength(1);
      const progressed = {
        ...f.request,
        version: 2,
        executionAttempts: 1,
        status: 'executing' as const,
      };
      await f.requests.save(progressed);
      const replay = await f.orders.beginRefundRequest(f.input);
      expect(replay.request).toMatchObject(progressed);
      expect(replay.order).toEqual(first.order);
      expect(await f.tickets.getById(f.selected.id)).toEqual(selected);
    } finally {
      await f.cleanup();
    }
  });

  it('persists immutable refund cause, components and purchase policy in the atomic request', async () => {
    const f = await fixture();
    try {
      const request = {
        ...f.request,
        refundCause: 'guest_request' as const,
        refundComponents: {
          admissionPaise: f.request.amountPaise,
          platformFeePaise: 0,
          paymentFeePaise: 0,
          feeTaxPaise: 0,
          otherPaidPaise: 0,
        },
        purchasePolicyVersion: 'm4-test',
      };
      await f.orders.beginRefundRequest({ ...f.input, request, expectedEventVersion: 1 });
      expect(await f.requests.getById(request.id)).toMatchObject(request);
      await expect(
        f.orders.beginRefundRequest({
          ...f.input,
          request: { ...request, purchasePolicyVersion: 'other-policy' },
          expectedEventVersion: 1,
        }),
      ).rejects.toThrow();
      expect((await f.requests.getById(request.id))?.purchasePolicyVersion).toBe('m4-test');
    } finally {
      await f.cleanup();
    }
  });

  it('aborts every document write if request creation fails after order/ticket writes were queued', async () => {
    const f = await fixture();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Calls retain the real transaction receiver below.
    const originalCreate = Transaction.prototype.create;
    let injected = false;
    const failure = vi.spyOn(Transaction.prototype, 'create').mockImplementation(function (
      this: Transaction,
      ref,
      data,
    ) {
      if (ref.parent.id === 'v2_refund_requests') {
        injected = true;
        throw new Error('Synthetic transaction interruption');
      }
      return originalCreate.call(this, ref, data);
    });
    try {
      await expect(f.orders.beginRefundRequest(f.input)).rejects.toThrow(/interruption/);
      expect(injected).toBe(true);
      expect(await f.orders.getById(f.order.id)).toMatchObject({
        status: 'paid',
        version: f.order.version,
      });
      expect(await f.requests.getById(f.request.id)).toBeNull();
      expect(await f.tickets.getById(f.selected.id)).toMatchObject(f.selected);
      failure.mockRestore();
      await expect(f.orders.beginRefundRequest(f.input)).resolves.toMatchObject({
        order: { status: 'refund_requested' },
      });
    } finally {
      failure.mockRestore();
      await f.cleanup();
    }
  });

  it.each(['actor', 'amount', 'selection', 'fingerprint'] as const)(
    'rejects a same-id replay with changed %s',
    async (kind) => {
      const f = await fixture();
      try {
        await f.orders.beginRefundRequest(f.input);
        const other = { ...f.request };
        if (kind === 'actor') other.requestedBy = 'ADMIN-other';
        if (kind === 'amount') other.amountPaise += 1;
        if (kind === 'selection') other.targetEntitlementIds = [];
        if (kind === 'fingerprint') other.intakeFingerprint = 'different-intent';
        await expect(f.orders.beginRefundRequest({ ...f.input, request: other })).rejects.toThrow();
        expect((await f.tickets.getById(f.selected.id))?.version).toBe(f.selected.version + 1);
        expect((await f.requests.getById(f.request.id))?.requestedBy).toBe(f.request.requestedBy);
      } finally {
        await f.cleanup();
      }
    },
  );

  it('admits exactly one of concurrent different refund intakes', async () => {
    const f = await fixture();
    try {
      const outcomes = await Promise.allSettled([
        f.orders.beginRefundRequest(f.input),
        new FirestoreOrderRepository(f.db).beginRefundRequest({
          ...f.input,
          request: { ...f.request, id: `${f.request.id}-other` },
        }),
      ]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await f.db.collection('v2_refund_requests').get()).size).toBe(1);
      expect((await f.tickets.getById(f.selected.id))?.version).toBe(f.selected.version + 1);
    } finally {
      await f.cleanup();
    }
  });

  it.each(['admission', 'transfer'] as const)(
    'serializes intake against %s and forces stale approval snapshots to be re-evaluated',
    async (race) => {
      const f = await fixture();
      try {
        const mutation =
          race === 'admission'
            ? f.tickets.claimAdmission(f.selected.id, f.order.eventId, { now: f.now })
            : f.tickets.save(
                changeEntitlementHolder(f.selected, {
                  expectedCurrentHolderUserId: f.selected.userId,
                  nextHolderUserId: 'USR-recipient',
                  holderName: 'Recipient',
                  now: f.now,
                }),
              );
        const outcomes = await Promise.allSettled([f.orders.beginRefundRequest(f.input), mutation]);
        const current = await f.tickets.getById(f.selected.id);
        const request = await f.requests.getById(f.request.id);
        if (request) {
          expect(current?.refundLock?.refundRequestId).toBe(f.request.id);
          expect(current?.scanCount).toBe(0);
          expect(current?.currentHolderUserId).toBe(f.selected.currentHolderUserId);
          const later = await f.tickets.claimAdmission(f.selected.id, f.order.eventId, {
            now: f.now,
          });
          expect(later.admitted).toBe(false);
        } else {
          expect(outcomes[0]?.status).toBe('rejected');
          expect((await f.orders.getById(f.order.id))?.status).toBe('paid');
          expect(current?.version).toBeGreaterThan(f.selected.version);
        }
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each([
    'void',
    'refund lock',
    'pending transfer',
    'foreign selection',
    'order version',
    'incomplete snapshot',
  ] as const)('rejects %s without creating any partial intake', async (kind) => {
    const f = await fixture();
    try {
      const input = {
        ...f.input,
        request: { ...f.request },
        expectedEntitlementVersions: [...f.input.expectedEntitlementVersions],
      };
      if (kind === 'foreign selection') input.request.targetEntitlementIds = ['ENT-foreign'];
      else if (kind === 'order version')
        await f.orders.save({ ...f.order, version: f.order.version + 1 });
      else if (kind === 'incomplete snapshot')
        input.expectedEntitlementVersions = [{ id: f.selected.id, version: f.selected.version }];
      else {
        const changed = { ...f.selected, version: f.selected.version + 1 };
        if (kind === 'void') changed.status = 'void';
        if (kind === 'refund lock')
          changed.refundLock = { refundRequestId: 'REF-other', frozenAt: f.now.toISOString() };
        if (kind === 'pending transfer') changed.pendingTransferId = 'TRANSFER-other';
        await f.tickets.save(changed);
        input.expectedEntitlementVersions = input.expectedEntitlementVersions.map((ticket) =>
          ticket.id === changed.id ? { ...ticket, version: changed.version } : ticket,
        );
      }
      const before = await f.tickets.getById(f.selected.id);
      await expect(f.orders.beginRefundRequest(input)).rejects.toThrow();
      expect(await f.requests.getById(f.request.id)).toBeNull();
      expect((await f.orders.getById(f.order.id))?.status).toBe('paid');
      expect(await f.tickets.getById(f.selected.id)).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });

  it('replays simultaneous identical intake without double freezes or versions', async () => {
    const f = await fixture();
    try {
      const result = await Promise.all([
        f.orders.beginRefundRequest(f.input),
        new FirestoreOrderRepository(f.db).beginRefundRequest(f.input),
      ]);
      expect(result[0]).toEqual(result[1]);
      expect((await f.db.collection('v2_refund_requests').get()).size).toBe(1);
      expect((await f.tickets.getById(f.selected.id))?.version).toBe(f.selected.version + 1);
      expect((await f.orders.getById(f.order.id))?.version).toBe(f.order.version + 1);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  it.each(['cancelled', 'material change'] as const)(
    'rejects a canonical %s that wins after refund cause evaluation',
    async (cause) => {
      const f = await fixture();
      try {
        await f.db
          .collection('v2_events')
          .doc(f.order.eventId)
          .update({
            version: 2,
            ...(cause === 'cancelled'
              ? { status: 'cancelled' }
              : { lastMaterialChangeAt: f.now.toISOString() }),
          });
        await expect(
          f.orders.beginRefundRequest({ ...f.input, expectedEventVersion: 1 }),
        ).rejects.toThrow(/event changed/);
        expect((await f.orders.getById(f.order.id))?.status).toBe('paid');
        expect(await f.requests.getById(f.request.id)).toBeNull();
        expect((await f.tickets.getById(f.selected.id))?.refundLock).toBeNull();
      } finally {
        await f.cleanup();
      }
    },
  );

  it('checks unselected ticket versions because scans affect approval thresholds', async () => {
    const f = await fixture();
    try {
      const other = f.entitlements.find((ticket) => ticket.id !== f.selected.id);
      if (!other) throw new Error('Missing unselected ticket');
      expect(
        (await f.tickets.claimAdmission(other.id, other.eventId, { now: f.now })).admitted,
      ).toBe(true);
      await expect(f.orders.beginRefundRequest(f.input)).rejects.toThrow();
      expect(await f.requests.getById(f.request.id)).toBeNull();
      expect((await f.orders.getById(f.order.id))?.status).toBe('paid');
      expect((await f.tickets.getById(f.selected.id))?.refundLock).toBeNull();
    } finally {
      await f.cleanup();
    }
  });
});
