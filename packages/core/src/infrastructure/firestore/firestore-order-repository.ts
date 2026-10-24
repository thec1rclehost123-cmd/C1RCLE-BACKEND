import { compareAndSet } from './compare-and-set.js';
import { paginateQuery, paginateUnordered } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import { bookingReferenceForOrderId } from '../../domain/models/order.js';
import type { Order, OrderStatus } from '../../domain/models/order.js';
import type {
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

  // One equality filter (served by the automatic single-field index) and a
  // projection of just the two fields seat counting needs, streamed in one read.
  // The status is filtered by the caller rather than with `in`, which could ask
  // for a composite index this deployment does not have.
  async listSeatClaims(eventId: EntityId) {
    const snap = await this.collection
      .where('eventId', '==', eventId)
      .select('status', 'lines')
      .get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      const lines = (data.lines ?? []) as { tierId: string; quantity: number }[];
      return {
        status: data.status as OrderStatus,
        lines: lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity })),
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
        sum + order.lines.reduce((s, line) => s + (line.tierId === tierId ? line.quantity : 0), 0)
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
    bookingReference: order.bookingReference ?? bookingReferenceForOrderId(order.id),
    eventId: order.eventId,
    organizationId: order.organizationId,
    userId: order.userId,
    contact: order.contact,
    status: order.status,
    lines: order.lines,
    currency: order.currency,
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
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function toOrder(data: DocumentData): Order {
  return {
    id: data.id as string,
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
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
