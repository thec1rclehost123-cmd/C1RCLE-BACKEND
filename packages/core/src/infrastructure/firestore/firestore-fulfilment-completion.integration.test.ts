import { randomUUID } from 'node:crypto';

import { Firestore, Transaction } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import { CheckoutService } from '../../application/checkout/checkout-service.js';
import { buildTicketSaleJournals } from '../../application/finance/financial-posting-service.js';
import { createCoreConfig } from '../../config/index.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { createCartReservation } from '../../domain/models/cart-reservation.js';
import { issueEntitlements, changeEntitlementHolder } from '../../domain/models/entitlement.js';
import { createEvent } from '../../domain/models/event.js';
import { orderReceiptFacts } from '../../domain/models/fulfilment.js';
import { createLedgerEntry } from '../../domain/models/ledger.js';
import { createOrder } from '../../domain/models/order.js';
import { applyProviderPaymentEvent } from '../../domain/models/provider-payment.js';
import { createRefundRequest } from '../../domain/models/refund-request.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';
import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';
import { FirestoreEventRepository } from './firestore-event-repository.js';
import { FirestoreFinancialJournalRepository } from './firestore-financial-journal-repository.js';
import { FirestoreLedgerRepository } from './firestore-ledger-repository.js';
import { FirestoreOrderRepository } from './firestore-order-repository.js';
import { FirestoreOutboxStore } from './firestore-outbox-store.js';
import { FirestoreProviderPaymentRepository } from './firestore-provider-payment-repository.js';

import type { ServiceDeps } from '../../application/context.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
async function fixture() {
  if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR))
    throw new Error('Completion requires loopback Emulator');
  const projectId = `demo-m4-complete-${randomUUID().slice(0, 8)}`;
  const db = new Firestore({ projectId });
  const now = new Date();
  const pricing = {
    currency: 'INR',
    lines: [
      {
        tierId: 'TIER-local',
        tierName: 'General',
        quantity: 1,
        unitPricePaise: 1000,
        subtotalPaise: 1000,
      },
    ],
    subtotalPaise: 1000,
    discountPaise: 0,
    discountedSubtotalPaise: 1000,
    platformFeePaise: 100,
    paymentFeePaise: 20,
    gstPaise: 22,
    grandTotalPaise: 1142,
    appliedPromoCode: null,
  };
  const orders = new FirestoreOrderRepository(db);
  const tickets = new FirestoreEntitlementRepository(db);
  const carts = new FirestoreCartReservationRepository(db);
  const journals = new FirestoreFinancialJournalRepository(db);
  const ledger = new FirestoreLedgerRepository(db);
  const outbox = new FirestoreOutboxStore(db);
  const providers = new FirestoreProviderPaymentRepository(db);
  const order = {
    ...createOrder({
      id: `ORD-${randomUUID()}`,
      eventId: `EVT-${randomUUID()}`,
      organizationId: 'ORG-local',
      userId: 'USR-local',
      contact: { name: 'Local Guest', email: 'local@example.test', phone: '+910000000000' },
      pricing,
      now,
    }),
    status: 'paid' as const,
    fulfillmentState: 'pending' as const,
    paymentId: 'pay-local',
    paymentIntentId: 'order-local',
    paidAt: now.toISOString(),
  };
  await orders.save(order);
  await db
    .collection('v2_events')
    .doc(order.eventId)
    .set({
      ...createEvent({
        id: order.eventId,
        organizationId: order.organizationId,
        venueId: 'VEN-local',
        title: 'Synthetic completion event',
        startAt: new Date(now.getTime() - 1000).toISOString(),
      }),
      status: 'published',
    });
  const hold = await carts.create(
    createCartReservation({
      id: `HOLD-${randomUUID()}`,
      eventId: order.eventId,
      organizationId: order.organizationId,
      userId: order.userId,
      lines: pricing.lines,
      pricing,
      appliedPromoCode: null,
      attribution: null,
      idempotencyKey: randomUUID(),
      now,
    }),
  );
  await carts.bindProviderOrder(hold.id, order.paymentIntentId);
  await carts.convertToOrder(hold.id, order.id);
  const ticket = issueEntitlements({ order, now })[0];
  if (!ticket) throw new Error('Missing fixture ticket');
  const issuance = domainEvent({
    id: deterministicDomainEventId('ticket.issued', ticket.id),
    type: 'ticket.issued',
    aggregateId: ticket.id,
    organizationId: order.organizationId,
    actorId: 'USR-local',
    payload: {
      entitlementId: ticket.id,
      orderId: order.id,
      eventId: order.eventId,
      purchaserUserId: ticket.userId,
      holderUserId: ticket.currentHolderUserId ?? null,
    },
    occurredAt: now.getTime(),
  });
  await tickets.save(ticket, null, issuance);
  await providers.save(
    applyProviderPaymentEvent(
      null,
      {
        type: 'captured',
        paymentId: order.paymentId,
        providerOrderId: order.paymentIntentId,
        orderId: null,
        correlated: true,
        amountPaise: order.grandTotalPaise,
        currency: order.currency,
        feePaise: 0,
        taxOnFeePaise: 0,
        occurredAt: now.toISOString(),
      },
      now,
    ),
  );
  await ledger.createBatch(
    ['ticket_revenue', 'host_payout', 'platform_fee', 'venue_share'].map((entryType) =>
      createLedgerEntry({
        id: `LEDGER-${entryType}`,
        organizationId: order.organizationId,
        orderId: order.id,
        eventId: order.eventId,
        entryType: entryType as 'ticket_revenue' | 'host_payout' | 'platform_fee' | 'venue_share',
        amount: entryType === 'ticket_revenue' || entryType === 'host_payout' ? 1000 : 0,
        status: 'settled',
        idempotencyKey: `local-${entryType}`,
        now,
      }),
    ),
  );
  const saleJournals = buildTicketSaleJournals({
    organizationId: order.organizationId,
    orderId: order.id,
    eventId: order.eventId,
    paymentId: order.paymentId,
    sourceType: 'online_payment_capture',
    providerConfirmed: true,
    currency: 'INR',
    ticketFaceValuePaise: 1000,
    discountPaise: 0,
    discountFundingOwner: null,
    netTicketRevenuePaise: 1000,
    platformFeePaise: 100,
    paymentFeePaise: 20,
    gstPaise: 22,
    providerFeePaise: 0,
    allocation: {
      platformPaise: 0,
      hostOrganizationId: order.organizationId,
      hostPaise: 1000,
      venueOrganizationId: order.organizationId,
      venuePaise: 0,
      promoterOrganizationId: null,
      promoterPaise: 0,
    },
    postedAt: now,
  });
  await journals.postBatch(saleJournals);
  const event = domainEvent({
    id: deterministicDomainEventId('order.fulfilled', order.id),
    type: 'order.fulfilled',
    aggregateId: order.id,
    organizationId: order.organizationId,
    actorId: 'USR-local',
    payload: { orderId: order.id, eventId: order.eventId, receiptFacts: orderReceiptFacts(order) },
    occurredAt: now.getTime(),
  });
  return {
    db,
    projectId,
    now,
    orders,
    tickets,
    carts,
    journals,
    outbox,
    order,
    hold,
    ticket,
    issuance,
    saleJournals,
    event,
    input: { orderId: order.id, holdId: hold.id, event, now },
    async cleanup() {
      for (const collection of [
        'v2_events',
        'v2_orders',
        'v2_refund_requests',
        'v2_entitlements',
        'v2_cart_reservations',
        'v2_hold_sequences',
        'v2_provider_payments',
        'v2_partner_ledger',
        'v2_partner_ledger_idempotency',
        'v2_financial_journals',
        'v2_financial_journal_lines',
        'v2_financial_journal_idempotency',
        'v2_outbox',
      ])
        await db.recursiveDelete(db.collection(collection));
      await db.terminate();
    },
  };
}

describe.runIf(EMULATOR)('M4 durable fulfillment completion', () => {
  it('round-trips exact original allocation on both authoritative hold and order', async () => {
    const f = await fixture();
    try {
      const saleAllocation = {
        version: 'sale-allocation-v1' as const,
        grossPaise: 1000,
        platformPaise: 150,
        hostPaise: 650,
        venuePaise: 200,
        promoterPaise: 0,
        hostOrganizationId: f.order.organizationId,
        venueOrganizationId: 'ORG-original-venue',
        promoterOrganizationId: null,
        partnershipId: 'PART-original',
        partnershipVersion: 3,
        onboardingId: 'ONB-original',
        onboardingVersion: 2,
        capturedAt: f.order.createdAt,
      };
      await f.orders.save({ ...f.order, saleAllocation, version: f.order.version + 1 });
      const hold = await f.carts.create({
        ...f.hold,
        id: 'HOLD-original-allocation',
        idempotencyKey: 'original-allocation',
        saleAllocation,
      });
      expect((await f.orders.getById(f.order.id))?.saleAllocation).toEqual(saleAllocation);
      expect((await f.carts.getById(hold.id))?.saleAllocation).toEqual(saleAllocation);
    } finally {
      await f.cleanup();
    }
  });

  it.each([true, false])(
    'repairs native original journals and materialized lines without admission writes (frozen partial ledger: %s)',
    async (frozen) => {
      const f = await fixture();
      try {
        const saleAllocation = {
          version: 'sale-allocation-v1' as const,
          grossPaise: 1000,
          platformPaise: 0,
          hostPaise: 1000,
          venuePaise: 0,
          promoterPaise: 0,
          hostOrganizationId: f.order.organizationId,
          venueOrganizationId: f.order.organizationId,
          promoterOrganizationId: null,
          partnershipId: null,
          partnershipVersion: null,
          onboardingId: null,
          onboardingVersion: null,
          capturedAt: f.order.createdAt,
        };
        await f.orders.save({
          ...f.order,
          status: 'refund_requested',
          ...(frozen ? { saleAllocation } : {}),
          version: f.order.version + 1,
        });
        if (frozen) {
          for (const type of ['host_payout', 'platform_fee', 'venue_share'])
            await f.db.collection('v2_partner_ledger').doc(`LEDGER-${type}`).delete();
          await f.db
            .collection('v2_partner_ledger')
            .doc('LEDGER-ticket_revenue')
            .update({ version: 4, status: 'paid_out' });
        }
        const ledger = new FirestoreLedgerRepository(f.db);
        const originalRevenue = (await ledger.findByOrder(f.order.id)).find(
          (row) => row.entryType === 'ticket_revenue',
        );
        await f.db.collection('v2_events').doc(f.order.eventId).update({ status: 'cancelled' });
        for (const collection of [
          'v2_financial_journals',
          'v2_financial_journal_lines',
          'v2_financial_journal_idempotency',
        ])
          await f.db.recursiveDelete(f.db.collection(collection));
        const deps = {
          config: createCoreConfig({
            redis: { url: 'redis://localhost:6379' },
            firestore: { projectId: f.projectId },
            clock: { now: () => f.now },
          }),
          repositories: {
            orders: f.orders,
            entitlements: f.tickets,
            cartReservations: f.carts,
            financialJournals: f.journals,
            ledger: new FirestoreLedgerRepository(f.db),
            events: new FirestoreEventRepository(f.db),
            providerPayments: new FirestoreProviderPaymentRepository(f.db),
          },
        } as unknown as ServiceDeps;
        const checkout = new CheckoutService(deps);
        const before = await f.tickets.getByOrderId(f.order.id);
        await checkout.repairSaleAccounting(f.order.id);
        expect(
          (await ledger.findByOrder(f.order.id)).find((row) => row.entryType === 'ticket_revenue'),
        ).toEqual(originalRevenue);
        expect(await ledger.findByOrder(f.order.id)).toHaveLength(4);
        const originals = await f.journals.findByOrderId(f.order.id);
        expect(originals).toHaveLength(2);
        expect(
          await Promise.all(originals.map((journal) => f.journals.hasAllLines(journal.id))),
        ).toEqual([true, true]);
        expect(await f.tickets.getByOrderId(f.order.id)).toEqual(before);
        expect(await f.orders.getById(f.order.id)).toMatchObject({
          status: 'refund_requested',
          fulfillmentState: 'pending',
        });
        // A crash after aggregate commit but before companion materialization is also recoverable.
        await f.db.recursiveDelete(f.db.collection('v2_financial_journal_lines'));
        await checkout.repairSaleAccounting(f.order.id);
        expect(
          await Promise.all(originals.map((journal) => f.journals.hasAllLines(journal.id))),
        ).toEqual([true, true]);
        expect(await f.tickets.getByOrderId(f.order.id)).toEqual(before);
      } finally {
        await f.cleanup();
      }
    },
  );

  it('gates native admission until marker and receipt intent commit, then preserves later custody on replay', async () => {
    const f = await fixture();
    try {
      expect((await f.tickets.claimAdmission(f.ticket.id, f.ticket.eventId)).admitted).toBe(false);
      const done = await f.orders.completeFulfilment(f.input);
      expect(done).toMatchObject({
        fulfillmentState: 'complete',
        receiptFacts: orderReceiptFacts(f.order),
      });
      expect(await f.outbox.hasEvent(f.event.id)).toBe(true);
      const moved = changeEntitlementHolder(f.ticket, {
        expectedCurrentHolderUserId: f.ticket.userId,
        nextHolderUserId: 'USR-recipient',
        holderName: 'Recipient',
        now: f.now,
      });
      await f.tickets.save(moved);
      const advanced = await f.tickets.getById(f.ticket.id);
      await f.orders.completeFulfilment(f.input);
      expect(await f.tickets.getById(f.ticket.id)).toEqual(advanced);
      expect((await f.tickets.claimAdmission(f.ticket.id, f.ticket.eventId)).admitted).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
  it('cannot commit the marker without the mandatory receipt intent when its write is interrupted', async () => {
    const f = await fixture();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Calls preserve the actual transaction receiver.
    const create = Transaction.prototype.create;
    const interruption = vi.spyOn(Transaction.prototype, 'create').mockImplementation(function (
      this: Transaction,
      ref,
      data,
    ) {
      if (ref.id === f.event.id) throw new Error('Synthetic receipt interruption');
      return create.call(this, ref, data);
    });
    try {
      await expect(f.orders.completeFulfilment(f.input)).rejects.toThrow(/receipt interruption/);
      expect((await f.orders.getById(f.order.id))?.fulfillmentState).toBe('pending');
      expect(await f.outbox.hasEvent(f.event.id)).toBe(false);
      expect((await f.tickets.claimAdmission(f.ticket.id, f.ticket.eventId)).admitted).toBe(false);
    } finally {
      interruption.mockRestore();
      await f.cleanup();
    }
  });
  it.each([
    'issuance intent',
    'allocation journal',
    'journal line',
    'capture amount',
    'receipt amount',
    'foreign hold',
    'event cancellation',
    'ledger amount',
    'issuance identity',
    'stored receipt identity',
  ] as const)('refuses incomplete or mismatched %s', async (missing) => {
    const f = await fixture();
    try {
      let input = f.input;
      if (missing === 'issuance intent')
        await f.db.collection('v2_outbox').doc(f.issuance.id).delete();
      if (missing === 'allocation journal') {
        const allocation = f.saleJournals.find((journal) =>
          journal.idempotencyKey.endsWith(':allocation'),
        );
        if (!allocation) throw new Error('Missing fixture allocation');
        await f.db.collection('v2_financial_journals').doc(allocation.id).delete();
      }
      if (missing === 'journal line') {
        const line = f.saleJournals[0]?.lines[0];
        if (!line) throw new Error('Missing fixture line');
        await f.db.collection('v2_financial_journal_lines').doc(line.id).delete();
      }
      if (missing === 'capture amount')
        await f.db
          .collection('v2_provider_payments')
          .doc(f.order.paymentId)
          .update({ capturedPaise: 1 });
      if (missing === 'receipt amount')
        input = {
          ...input,
          event: {
            ...f.event,
            payload: {
              ...f.event.payload,
              receiptFacts: { ...orderReceiptFacts(f.order), grandTotalPaise: 1 },
            },
          },
        };
      if (missing === 'ledger amount')
        await f.db.collection('v2_partner_ledger').doc('LEDGER-host_payout').update({ amount: 1 });
      if (missing === 'issuance identity')
        await f.db
          .collection('v2_outbox')
          .doc(f.issuance.id)
          .update({ 'payload.payload.eventId': 'EVT-foreign' });
      if (missing === 'stored receipt identity')
        await f.outbox.append({ ...f.event, aggregateId: 'ORD-foreign' });
      if (missing === 'event cancellation')
        await f.db.collection('v2_events').doc(f.order.eventId).update({ status: 'cancelled' });
      if (missing === 'foreign hold')
        await f.db
          .collection('v2_cart_reservations')
          .doc(f.hold.id)
          .update({ eventId: 'EVT-foreign' });
      await expect(f.orders.completeFulfilment(input)).rejects.toThrow();
      expect((await f.orders.getById(f.order.id))?.fulfillmentState).toBe('pending');
      if (missing === 'stored receipt identity')
        expect((await f.db.collection('v2_outbox').doc(f.event.id).get()).data()?.aggregateId).toBe(
          'ORD-foreign',
        );
      else expect(await f.outbox.hasEvent(f.event.id)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
  it('keeps compensation pending, atomically starts its refund, and rejects racing admission issuance', async () => {
    const f = await fixture();
    try {
      await f.db.collection('v2_entitlements').doc(f.ticket.id).delete();
      await f.db.collection('v2_outbox').doc(f.issuance.id).delete();
      const blocked = {
        ...f.order,
        version: f.order.version + 1,
        compensationRequired: {
          reason: 'capacity_unavailable' as const,
          requestedAt: f.now.toISOString(),
        },
      };
      await f.orders.save(blocked);
      const request = createRefundRequest({
        id: 'REF-COMP-local',
        orderId: f.order.id,
        organizationId: f.order.organizationId,
        amountPaise: f.order.grandTotalPaise,
        requestedBy: 'system:checkout-compensation',
        reason: 'Synthetic unavailable admission',
        intakeFingerprint: 'synthetic-compensation',
        scope: 'amount_only',
        hasRedeemedEntitlement: false,
        refundCause: 'fulfillment_failure',
        refundComponents: {
          admissionPaise: 1000,
          platformFeePaise: 100,
          paymentFeePaise: 20,
          feeTaxPaise: 22,
          otherPaidPaise: 0,
        },
        purchasePolicyVersion: 'm4-test',
        sourceEventVersion: 1,
        now: f.now,
      });
      const result = await Promise.allSettled([
        f.orders.beginRefundRequest({
          request,
          expectedOrderVersion: blocked.version,
          expectedEventVersion: 1,
          expectedEntitlementVersions: [],
          now: f.now,
        }),
        f.tickets.save(f.ticket, null, f.issuance),
      ]);
      expect(result[0]?.status).toBe('fulfilled');
      expect(result[1]?.status).toBe('rejected');
      expect(await f.tickets.getByOrderId(f.order.id)).toHaveLength(0);
      expect(await f.orders.getById(f.order.id)).toMatchObject({
        status: 'refund_requested',
        fulfillmentState: 'pending',
        compensationRequired: blocked.compensationRequired,
      });
      await expect(f.orders.completeFulfilment(f.input)).rejects.toThrow();
      expect(await f.outbox.hasEvent(f.event.id)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it('repairs materialized journal lines and missing issuance intents without resetting advanced tickets', async () => {
    const f = await fixture();
    try {
      const line = f.saleJournals[0]?.lines[0];
      if (!line) throw new Error('Missing fixture line');
      await f.db.collection('v2_financial_journal_lines').doc(line.id).delete();
      await f.db.collection('v2_outbox').doc(f.issuance.id).delete();
      const moved = changeEntitlementHolder(f.ticket, {
        expectedCurrentHolderUserId: f.ticket.userId,
        nextHolderUserId: 'USR-recipient',
        holderName: 'Recipient',
        now: f.now,
      });
      await f.tickets.save(moved);
      const advanced = await f.tickets.getById(f.ticket.id);
      await f.tickets.save(f.ticket, null, f.issuance);
      await f.journals.postBatch(f.saleJournals);
      await expect(f.orders.completeFulfilment(f.input)).resolves.toMatchObject({
        fulfillmentState: 'complete',
      });
      expect(await f.tickets.getById(f.ticket.id)).toEqual(advanced);
    } finally {
      await f.cleanup();
    }
  });
});
