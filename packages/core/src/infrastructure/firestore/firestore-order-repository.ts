import { ConflictError, InvalidOperationError } from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { completeOrderFulfilment } from '../../domain/models/fulfilment.js';
import { bookingReferenceForOrderId } from '../../domain/models/order.js';
import { prepareRefundIntake } from '../../domain/models/refund-intake.js';
import { assertRsvpCapacity, cancelledRsvp } from '../../domain/models/rsvp.js';

import { compareAndSet } from './compare-and-set.js';
import { entitlementToDoc, entitlementFromDoc } from './firestore-entitlement-repository.js';
import {
  financialJournalFromDocument,
  financialJournalLineDocument,
  JOURNAL_COLLECTION,
  JOURNAL_LINE_COLLECTION,
} from './firestore-financial-journal-repository.js';
import { outboxDocument } from './firestore-outbox-store.js';
import { refundRequestFromDoc, refundRequestToDoc } from './firestore-refund-request-repository.js';
import { paginateQuery, paginateUnordered } from './pagination.js';

import type { DomainEvent } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';
import type { CartReservation } from '../../domain/models/cart-reservation.js';
import type { TicketTier } from '../../domain/models/event-catalog.js';
import type { Event } from '../../domain/models/event.js';
import type { FulfilmentCompletionInput } from '../../domain/models/fulfilment.js';
import type { LedgerEntry } from '../../domain/models/ledger.js';
import type { Order, OrderStatus } from '../../domain/models/order.js';
import type { ProviderPayment } from '../../domain/models/provider-payment.js';
import type { RefundIntakeInput } from '../../domain/models/refund-intake.js';
import type {
  RsvpAcquisition,
  OrderRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_orders';

/**
 * Firestore adapter for `OrderRepository` (Phase 4).
 * Same interface as `MemoryOrderRepository` — no route/service change to swap this in.
 * `memberIds`/`paymentId` indexes are denormalized for query access.
 */
export class FirestoreOrderRepository implements OrderRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async completeFulfilment(input: FulfilmentCompletionInput) {
    const orderRef = this.collection.doc(input.orderId);
    const eventRef = this.db.collection('v2_outbox').doc(input.event.id);
    return this.db.runTransaction(async (tx) => {
      const [orderSnap, holdSnap, ticketsSnap, ledgerSnap, journalsSnap, eventSnap] =
        await Promise.all([
          tx.get(orderRef),
          tx.get(this.db.collection('v2_cart_reservations').doc(input.holdId)),
          tx.get(this.db.collection('v2_entitlements').where('orderId', '==', input.orderId)),
          tx.get(this.db.collection('v2_partner_ledger').where('orderId', '==', input.orderId)),
          tx.get(this.db.collection(JOURNAL_COLLECTION).where('sourceId', '==', input.orderId)),
          tx.get(eventRef),
        ]);
      const orderData = orderSnap.data();
      const order = orderData ? toOrder(orderData) : null;
      const tickets = ticketsSnap.docs.map((doc) => entitlementFromDoc(doc.data()));
      const issuanceSnaps = await Promise.all(
        tickets.map((ticket) =>
          tx.get(
            this.db
              .collection('v2_outbox')
              .doc(deterministicDomainEventId('ticket.issued', ticket.id)),
          ),
        ),
      );
      const journals = journalsSnap.docs.map((doc) => financialJournalFromDocument(doc.data()));
      const lines = journals.flatMap((journal) => journal.lines.map((line) => ({ journal, line })));
      const lineSnaps = await Promise.all(
        lines.map(({ line }) => tx.get(this.db.collection(JOURNAL_LINE_COLLECTION).doc(line.id))),
      );
      if (
        !lineSnaps.every((snap, index) => {
          const item = lines[index];
          return (
            item &&
            snap.exists &&
            Object.entries(financialJournalLineDocument(item.journal, item.line)).every(
              ([key, value]) => JSON.stringify(snap.data()?.[key]) === JSON.stringify(value),
            )
          );
        })
      )
        throw new ConflictError('Fulfillment journal lines are incomplete');
      const paymentSnap = order?.paymentId
        ? await tx.get(this.db.collection('v2_provider_payments').doc(order.paymentId))
        : null;
      const eventState = order
        ? await tx.get(this.db.collection('v2_events').doc(order.eventId))
        : null;
      const result = completeOrderFulfilment(input, {
        order,
        event: eventState?.exists ? (eventState.data() as Event) : null,
        hold: holdSnap.exists ? (holdSnap.data() as CartReservation) : null,
        tickets,
        issuanceEvents: issuanceSnaps
          .filter((snap) => snap.exists)
          .map((snap) => snap.data()?.payload as DomainEvent),
        ledger: ledgerSnap.docs.map((doc) => doc.data() as LedgerEntry),
        journals,
        providerPayment: paymentSnap?.exists ? (paymentSnap.data() as ProviderPayment) : null,
      });
      const storedEvent = eventSnap.exists ? (eventSnap.data()?.payload as DomainEvent) : null;
      if (
        storedEvent &&
        (storedEvent.type !== 'order.fulfilled' ||
          storedEvent.aggregateId !== result.id ||
          storedEvent.organizationId !== result.organizationId ||
          storedEvent.payload.orderId !== result.id ||
          (storedEvent.payload.receiptFacts &&
            JSON.stringify(storedEvent.payload.receiptFacts) !==
              JSON.stringify(input.event.payload.receiptFacts)))
      )
        throw new ConflictError('Fulfillment intent identity conflict');
      if (result !== order) tx.set(orderRef, toDoc(result));
      if (!storedEvent) tx.create(eventRef, outboxDocument(input.event));
      else if (!storedEvent.payload.receiptFacts) tx.update(eventRef, { payload: input.event });
      return result;
    });
  }

  async beginRefundRequest(input: RefundIntakeInput) {
    const orderRef = this.collection.doc(input.request.orderId);
    const requestRef = this.db.collection('v2_refund_requests').doc(input.request.id);
    return this.db.runTransaction(async (tx) => {
      const [orderSnap, requestSnap, ticketsSnap] = await Promise.all([
        tx.get(orderRef),
        tx.get(requestRef),
        tx.get(this.db.collection('v2_entitlements').where('orderId', '==', input.request.orderId)),
      ]);
      const orderData = orderSnap.data();
      const requestData = requestSnap.data();
      const eventSnap =
        input.expectedEventVersion === undefined || !orderData
          ? null
          : await tx.get(this.db.collection('v2_events').doc(orderData.eventId as string));
      const result = prepareRefundIntake(
        input,
        orderData ? toOrder(orderData) : null,
        ticketsSnap.docs.map((doc) => entitlementFromDoc(doc.data())),
        requestData ? refundRequestFromDoc(requestData) : null,
        eventSnap?.exists ? (eventSnap.data() as Event) : null,
      );
      if (!result.replay) {
        tx.set(orderRef, toDoc(result.order));
        for (const ticket of result.entitlements)
          tx.set(this.db.collection('v2_entitlements').doc(ticket.id), entitlementToDoc(ticket));
        tx.create(requestRef, refundRequestToDoc(result.request));
      }
      return { request: result.request, order: result.order };
    });
  }

  async acquireRsvp(input: RsvpAcquisition) {
    const line = input.order.lines[0];
    const purchaserId = input.order.userId;
    if (!line || !purchaserId) throw new InvalidOperationError('Invalid RSVP allocation');
    const ref = this.collection.doc(input.order.id);
    const sequence = this.db.collection('v2_hold_sequences').doc(input.order.eventId);
    return this.db.runTransaction(async (tx) => {
      const [existing, sequenceSnap, event, tier, orders, holds, tickets] = await Promise.all([
        tx.get(ref),
        tx.get(sequence),
        tx.get(this.db.collection('v2_events').doc(input.order.eventId)),
        tx.get(this.db.collection('v2_event_catalog_tiers').doc(line.tierId)),
        tx.get(this.collection.where('eventId', '==', input.order.eventId)),
        tx.get(
          this.db.collection('v2_cart_reservations').where('eventId', '==', input.order.eventId),
        ),
        tx.get(this.db.collection('v2_entitlements').where('orderId', '==', input.order.id)),
      ]);
      const existingData = existing.data();
      if (existingData) {
        const order = toOrder(existingData);
        if (order.userId !== input.order.userId || order.status !== 'paid')
          throw new ConflictError('This RSVP is no longer available');
        return { order, entitlements: tickets.docs.map((doc) => entitlementFromDoc(doc.data())) };
      }
      assertRsvpCapacity(
        input,
        event.exists ? (event.data() as Event) : null,
        tier.exists ? (tier.data() as TicketTier) : null,
        orders.docs.map((doc) => toOrder(doc.data())),
        holds.docs.map((doc) => doc.data() as CartReservation),
      );
      tx.set(sequence, { last: Number(sequenceSnap.data()?.last ?? 0) + 1 }, { merge: true });
      tx.create(ref, toDoc(input.order));
      const issuedEvents = [
        domainEvent({
          id: deterministicDomainEventId('order.fulfilled', input.order.id),
          type: 'order.fulfilled',
          aggregateId: input.order.id,
          organizationId: input.order.organizationId,
          actorId: purchaserId,
          payload: { orderId: input.order.id, eventId: input.order.eventId },
          occurredAt: input.now.getTime(),
        }),
        ...input.entitlements.map((ticket) =>
          domainEvent({
            id: deterministicDomainEventId('ticket.issued', ticket.id),
            type: 'ticket.issued',
            aggregateId: ticket.id,
            organizationId: ticket.organizationId,
            actorId: purchaserId,
            payload: {
              entitlementId: ticket.id,
              orderId: input.order.id,
              eventId: ticket.eventId,
              purchaserUserId: ticket.userId,
              holderUserId:
                ticket.currentHolderUserId === undefined
                  ? ticket.userId
                  : ticket.currentHolderUserId,
            },
            occurredAt: input.now.getTime(),
          }),
        ),
      ];
      for (const event of issuedEvents)
        tx.create(this.db.collection('v2_outbox').doc(event.id), outboxDocument(event));

      for (const ticket of input.entitlements)
        tx.create(this.db.collection('v2_entitlements').doc(ticket.id), entitlementToDoc(ticket));
      return { order: input.order, entitlements: input.entitlements };
    });
  }

  async cancelRsvp(orderId: EntityId, userId: EntityId, now: Date) {
    const ref = this.collection.doc(orderId);
    return this.db.runTransaction(async (tx) => {
      const [stored, tickets] = await Promise.all([
        tx.get(ref),
        tx.get(this.db.collection('v2_entitlements').where('orderId', '==', orderId)),
      ]);
      const storedData = stored.data();
      const order = storedData ? toOrder(storedData) : null;
      const result = cancelledRsvp(
        order,
        tickets.docs.map((doc) => entitlementFromDoc(doc.data())),
        userId,
        now,
      );
      if (order?.status === 'cancelled') return order;
      const sequence = this.db.collection('v2_hold_sequences').doc(result.order.eventId);
      const sequenceSnap = await tx.get(sequence);
      tx.set(sequence, { last: Number(sequenceSnap.data()?.last ?? 0) + 1 }, { merge: true });
      const event = domainEvent({
        id: deterministicDomainEventId('rsvp.cancelled', result.order.id),
        type: 'rsvp.cancelled',
        aggregateId: result.order.id,
        organizationId: result.order.organizationId,
        actorId: userId,
        payload: { orderId: result.order.id, eventId: result.order.eventId },
        occurredAt: now.getTime(),
      });
      tx.set(this.db.collection('v2_outbox').doc(event.id), outboxDocument(event));
      tx.set(ref, toDoc(result.order));
      for (const ticket of result.entitlements)
        tx.set(this.db.collection('v2_entitlements').doc(ticket.id), entitlementToDoc(ticket));
      return result.order;
    });
  }

  async getById(orderId: EntityId): Promise<Order | null> {
    const snap = await this.collection.doc(orderId).get();
    const data = snap.data();
    return data ? toOrder(data) : null;
  }

  async getByBookingReference(bookingReference: string): Promise<Order | null> {
    const snap = await this.collection
      .where('bookingReference', '==', bookingReference.toUpperCase())
      .limit(1)
      .get();
    if (snap.empty) return null;
    const data = snap.docs[0]?.data();
    return data ? toOrder(data) : null;
  }

  async getByPaymentId(paymentId: string): Promise<Order | null> {
    const snap = await this.collection.where('paymentId', '==', paymentId).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    if (!doc) return null;
    const data = doc.data();
    return data ? toOrder(data) : null;
  }

  async getByIdempotencyKey(key: string): Promise<Order | null> {
    const snap = await this.collection.where('idempotencyKey', '==', key).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    if (!doc) return null;
    const data = doc.data();
    return data ? toOrder(data) : null;
  }

  // Index-free (single-field filter; newest-first sort happens in code —
  // see `paginateUnordered`): these reads must work with zero provisioned
  // composite indexes (wallet, door, partner surfaces).
  async listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const base = this.collection.where('userId', '==', userId);
    return paginateUnordered(base, query, toOrder);
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const base = this.collection.where('organizationId', '==', organizationId);
    // The deployed index supports this exact predicate/order pair. A recent
    // partner order page must be globally newest-first; sorting only the first
    // arbitrary Firestore page can silently omit the actual latest orders.
    return paginateQuery(base.orderBy('createdAt', 'desc'), query, toOrder);
  }

  /**
   * Index-free by design: single-field `eventId` filter only (automatic
   * single-field index, no composite). The sole caller,
   * `InventoryService.getSoldCount`, pages through EVERYTHING and sums —
   * result order is irrelevant to it — so server-side ordering is skipped
   * rather than demanding a composite index (repo convention: filtering
   * happens in code, not in new composite indexes). Callers that need an
   * order must sort the returned page client-side.
   */
  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const base = this.collection.where('eventId', '==', eventId);
    return paginateQuery(base, query, toOrder);
  }

  /** Single-field nested equality uses Firestore's automatic index; no composite index required. */
  async listByPromoter(promoterId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const base = this.collection.where('attribution.promoterId', '==', promoterId);
    return paginateUnordered(base, query, toOrder);
  }

  /** Event + immutable Promoter equality filters use the declared composite index. */
  async listByPromoterForEvent(
    promoterId: EntityId,
    eventId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Order>> {
    const base = this.collection
      .where('eventId', '==', eventId)
      .where('attribution.promoterId', '==', promoterId);
    return paginateUnordered(base, query, toOrder);
  }

  // One equality filter (served by the automatic single-field index) and a
  // projection of just the two fields seat counting needs, streamed in one read.
  // The status is filtered by the caller rather than with `in`, which could ask
  // for a composite index this deployment does not have.
  async listSeatClaims(eventId: EntityId) {
    const snap = await this.collection
      .where('eventId', '==', eventId)
      .select('status', 'lines', 'refundedTicketClaims')
      .get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      const lines = (data.lines ?? []) as {
        tierId: string;
        pricingPhaseId?: string | null;
        quantity: number;
        guestCount?: number;
        admissionMode?: 'bundle' | 'per_person';
      }[];
      return {
        status: data.status as OrderStatus,
        refundedTicketClaims: (data.refundedTicketClaims as Order['refundedTicketClaims']) ?? [],
        lines: lines.map((line) => ({
          tierId: line.tierId,
          ...(line.pricingPhaseId === undefined ? {} : { pricingPhaseId: line.pricingPhaseId }),
          quantity: line.quantity,
          ...(line.guestCount === undefined ? {} : { guestCount: line.guestCount }),
          ...(line.admissionMode === undefined ? {} : { admissionMode: line.admissionMode }),
        })),
      };
    });
  }

  async countPaidQuantityByUserAndEvent(
    userId: EntityId,
    eventId: EntityId,
    tierId: EntityId,
  ): Promise<number> {
    // Single-field equality on `userId` (already indexed by `listByUser`),
    // then event/status/tier filtered in application code — bounded by one
    // user's order history, no new composite index required.
    const snap = await this.collection.where('userId', '==', userId).get();
    return snap.docs.reduce((sum, doc) => {
      const order = toOrder(doc.data());
      if (order.eventId !== eventId || order.status !== 'paid') return sum;
      return (
        sum +
        order.lines.reduce(
          (s, line) =>
            s +
            (line.tierId === tierId
              ? line.quantity * (line.admissionMode === 'per_person' ? (line.guestCount ?? 1) : 1)
              : 0),
          0,
        )
      );
    }, 0);
  }

  async listAll(query: PaginationQuery): Promise<Page<Order>> {
    const base = this.collection.orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toOrder);
  }

  async save(order: Order, _tx?: TxContext | null): Promise<void> {
    // Compare-and-set: a write of version N must find N-1 (see compare-and-set.ts).
    await compareAndSet(this.db, this.collection, order, toDoc);
  }

  async delete(orderId: EntityId, _tx?: TxContext | null): Promise<void> {
    await this.collection.doc(orderId).delete();
  }
}

function toDoc(order: Order): DocumentData {
  return {
    id: order.id,
    ...(order.compensationRequired ? { compensationRequired: order.compensationRequired } : {}),
    ...(order.fulfillmentState ? { fulfillmentState: order.fulfillmentState } : {}),
    ...(order.fulfillmentCompletedAt
      ? { fulfillmentCompletedAt: order.fulfillmentCompletedAt }
      : {}),
    ...(order.receiptFacts ? { receiptFacts: order.receiptFacts } : {}),
    ...(order.saleAllocation ? { saleAllocation: order.saleAllocation } : {}),
    ...(order.bookedAt ? { bookedAt: order.bookedAt } : {}),
    bookingReference: order.bookingReference ?? bookingReferenceForOrderId(order.id),
    eventId: order.eventId,
    organizationId: order.organizationId,
    userId: order.userId,
    contact: order.contact,
    status: order.status,
    lines: order.lines,
    currency: order.currency,
    ...(order.feePolicy ? { feePolicy: order.feePolicy } : {}),
    ...(order.accountingPolicy ? { accountingPolicy: order.accountingPolicy } : {}),
    ...(order.refundSnapshot ? { refundSnapshot: order.refundSnapshot } : {}),
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    discountFundingOwner: order.discountFundingOwner ?? null,
    discountedSubtotalPaise: order.discountedSubtotalPaise,
    platformFeePaise: order.platformFeePaise,
    paymentFeePaise: order.paymentFeePaise,
    gstPaise: order.gstPaise,
    grandTotalPaise: order.grandTotalPaise,
    appliedPromoCode: order.appliedPromoCode,
    attribution: order.attribution,
    paymentIntentId: order.paymentIntentId,
    paymentId: order.paymentId,
    paidAt: order.paidAt,
    reservationExpiresAt: order.reservationExpiresAt,
    failureReason: order.failureReason,
    eventCancellation: order.eventCancellation ?? null,
    refundedPaise: order.refundedPaise,
    appliedRefundRequestIds: order.appliedRefundRequestIds ?? [],
    refundedTicketClaims: order.refundedTicketClaims ?? [],
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function toOrder(data: DocumentData): Order {
  return {
    id: data.id as string,
    ...(data.compensationRequired
      ? { compensationRequired: data.compensationRequired as Order['compensationRequired'] }
      : {}),
    ...(data.fulfillmentState
      ? { fulfillmentState: data.fulfillmentState as Order['fulfillmentState'] }
      : {}),
    ...(data.fulfillmentCompletedAt
      ? { fulfillmentCompletedAt: data.fulfillmentCompletedAt as string }
      : {}),
    ...(data.receiptFacts ? { receiptFacts: data.receiptFacts as Order['receiptFacts'] } : {}),
    ...(data.saleAllocation
      ? { saleAllocation: data.saleAllocation as Order['saleAllocation'] }
      : {}),
    ...(typeof data.bookedAt === 'string' ? { bookedAt: data.bookedAt } : {}),
    bookingReference:
      (data.bookingReference as string | undefined) ??
      bookingReferenceForOrderId(data.id as string),
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    userId: data.userId as string | null,
    contact: data.contact as Order['contact'],
    status: data.status as OrderStatus,
    lines: data.lines as Order['lines'],
    currency: data.currency as string,
    ...(data.feePolicy ? { feePolicy: data.feePolicy as Order['feePolicy'] } : {}),
    ...(data.accountingPolicy
      ? { accountingPolicy: data.accountingPolicy as Order['accountingPolicy'] }
      : {}),
    ...(data.refundSnapshot
      ? { refundSnapshot: data.refundSnapshot as Order['refundSnapshot'] }
      : {}),
    subtotalPaise: data.subtotalPaise as number,
    discountPaise: data.discountPaise as number,
    discountFundingOwner:
      (data.discountFundingOwner as Order['discountFundingOwner'] | undefined) ?? null,
    discountedSubtotalPaise: data.discountedSubtotalPaise as number,
    platformFeePaise: data.platformFeePaise as number,
    paymentFeePaise: data.paymentFeePaise as number,
    gstPaise: data.gstPaise as number,
    grandTotalPaise: data.grandTotalPaise as number,
    appliedPromoCode: data.appliedPromoCode as string | null,
    attribution: data.attribution as Order['attribution'],
    paymentIntentId: data.paymentIntentId as string | null,
    paymentId: data.paymentId as string | null,
    paidAt: data.paidAt as string | null,
    reservationExpiresAt: data.reservationExpiresAt as string,
    failureReason: data.failureReason as string | null,
    eventCancellation: (data.eventCancellation as Order['eventCancellation'] | undefined) ?? null,
    // Existing orders written before this field existed have no value —
    // they predate refunds, so zero is the correct read, not a guess.
    refundedPaise: (data.refundedPaise as number | undefined) ?? 0,
    appliedRefundRequestIds: (data.appliedRefundRequestIds as string[] | undefined) ?? [],
    refundedTicketClaims: (data.refundedTicketClaims as Order['refundedTicketClaims']) ?? [],
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
