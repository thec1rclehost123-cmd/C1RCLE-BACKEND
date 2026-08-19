import { compareAndSet } from './compare-and-set.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  CartReservation,
  CartReservationStatus,
} from '../../domain/models/cart-reservation.js';
import type { CartReservationRepository, TxContext } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_cart_reservations';

/**
 * Firestore adapter for `CartReservationRepository` (Phase 4).
 * Same interface as `MemoryCartReservationRepository`.
 */
export class FirestoreCartReservationRepository implements CartReservationRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async create(reservation: CartReservation, _tx?: TxContext | null): Promise<void> {
    // Compare-and-set: a write of version N must find N-1
    await compareAndSet(this.db, this.collection, reservation, toDoc);
  }

  async getById(reservationId: EntityId): Promise<CartReservation | null> {
    const snap = await this.collection.doc(reservationId).get();
    const data = snap.data();
    return data ? toCartReservation(data) : null;
  }

  async getByIdempotencyKey(key: string): Promise<CartReservation | null> {
    const snap = await this.collection.where('idempotencyKey', '==', key).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    if (!doc) return null;
    const data = doc.data();
    return data ? toCartReservation(data) : null;
  }

  async release(reservationId: EntityId, _tx?: TxContext | null): Promise<void> {
    const ref = this.collection.doc(reservationId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return;
      const released: CartReservation = {
        ...toCartReservation(data),
        status: 'released',
      };
      tx.set(ref, toDoc(released));
    });
  }

  async convertToOrder(
    reservationId: EntityId,
    orderId: EntityId,
    _tx?: TxContext | null,
  ): Promise<void> {
    const ref = this.collection.doc(reservationId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return;
      const converted: CartReservation = {
        ...toCartReservation(data),
        status: 'converted',
        convertedOrderId: orderId,
      };
      tx.set(ref, toDoc(converted));
    });
  }

  async cleanupExpired(now: Date, _tx?: TxContext | null): Promise<number> {
    const snap = await this.collection
      .where('status', '==', 'active')
      .where('expiresAt', '<=', now.toISOString())
      .get();

    if (snap.empty) return 0;

    const batch = this.db.batch();
    for (const doc of snap.docs) {
      const data = doc.data();
      const released: CartReservation = {
        ...toCartReservation(data),
        status: 'released',
      };
      batch.set(doc.ref, toDoc(released));
    }
    await batch.commit();
    return snap.size;
  }
}

function toDoc(reservation: CartReservation): DocumentData {
  return {
    id: reservation.id,
    eventId: reservation.eventId,
    organizationId: reservation.organizationId,
    userId: reservation.userId,
    lines: reservation.lines,
    pricing: reservation.pricing,
    appliedPromoCode: reservation.appliedPromoCode,
    attribution: reservation.attribution,
    status: reservation.status,
    expiresAt: reservation.expiresAt,
    convertedOrderId: reservation.convertedOrderId,
    idempotencyKey: reservation.idempotencyKey,
    version: reservation.version,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
  };
}

function toCartReservation(data: DocumentData): CartReservation {
  return {
    id: data.id as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    userId: data.userId as string | null,
    lines: data.lines as CartReservation['lines'],
    pricing: data.pricing as CartReservation['pricing'],
    appliedPromoCode: data.appliedPromoCode as string | null,
    attribution: data.attribution as CartReservation['attribution'],
    status: data.status as CartReservationStatus,
    expiresAt: data.expiresAt as string,
    convertedOrderId: data.convertedOrderId as string | null,
    idempotencyKey: data.idempotencyKey as string,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
