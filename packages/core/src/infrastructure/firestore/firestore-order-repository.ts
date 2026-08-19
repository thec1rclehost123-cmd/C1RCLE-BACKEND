import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
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

  async listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const base = this.collection.where('userId', '==', userId).orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toOrder);
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toOrder);
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const base = this.collection.where('eventId', '==', eventId).orderBy('createdAt', 'desc');
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
    eventId: order.eventId,
    organizationId: order.organizationId,
    userId: order.userId,
    contact: order.contact,
    status: order.status,
    lines: order.lines,
    currency: order.currency,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
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
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function toOrder(data: DocumentData): Order {
  return {
    id: data.id as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    userId: data.userId as string | null,
    contact: data.contact as Order['contact'],
    status: data.status as OrderStatus,
    lines: data.lines as Order['lines'],
    currency: data.currency as string,
    subtotalPaise: data.subtotalPaise as number,
    discountPaise: data.discountPaise as number,
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
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
