import type { EntityId } from '../../domain/identity.js';
import type { PromoRedemptionRepository, TxContext } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_promo_redemptions';
const LOCK_COLLECTION = 'v2_promo_redemption_locks';

/**
 * Firestore adapter for `PromoRedemptionRepository` (Phase 4).
 * Shared with Phase 3 event-catalog promo codes.
 */
export class FirestorePromoRedemptionRepository implements PromoRedemptionRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async claim(input: {
    redemption: {
      id: EntityId;
      promoId: EntityId;
      orderId: EntityId;
      userId: EntityId | null;
      redeemedAt: string;
    };
    promoIds: EntityId[];
    historicalRedemptionCount: number;
    maxRedemptions: number | null;
    maxPerUser: number | null;
  }): Promise<'claimed' | 'already_claimed' | 'global_limit' | 'user_limit'> {
    const aliases = [...new Set(input.promoIds)];
    const redemptionRef = this.collection.doc(input.redemption.id);
    const lockRef = this.db.collection(LOCK_COLLECTION).doc(input.redemption.promoId);
    const orderQuery = this.collection.where('orderId', '==', input.redemption.orderId).limit(1);
    const promoQuery = this.collection.where('promoId', 'in', aliases);

    return this.db.runTransaction(async (tx) => {
      // Every claimant for a canonical promo reads and updates the same lock
      // document. Firestore retries a transaction when that document changes,
      // serializing the query-based limit check without relying on process locks.
      const [lock, direct, byOrder, byPromo] = await Promise.all([
        tx.get(lockRef),
        tx.get(redemptionRef),
        tx.get(orderQuery),
        tx.get(promoQuery),
      ]);
      void lock;

      if (direct.exists || !byOrder.empty) return 'already_claimed';
      if (
        input.maxRedemptions !== null &&
        Math.max(byPromo.size, input.historicalRedemptionCount) >= input.maxRedemptions
      ) {
        return 'global_limit';
      }
      if (input.maxPerUser !== null && input.redemption.userId) {
        const userCount = byPromo.docs.filter(
          (document) => document.data().userId === input.redemption.userId,
        ).length;
        if (userCount >= input.maxPerUser) return 'user_limit';
      }

      tx.set(redemptionRef, toDoc(input.redemption));
      tx.set(
        lockRef,
        { promoId: input.redemption.promoId, updatedAt: input.redemption.redeemedAt },
        { merge: true },
      );
      return 'claimed';
    });
  }

  async create(
    redemption: {
      id: EntityId;
      promoId: EntityId;
      orderId: EntityId;
      userId: EntityId | null;
      redeemedAt: string;
    },
    _tx?: TxContext | null,
  ): Promise<void> {
    const ref = this.collection.doc(redemption.id);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        // Idempotent: if same order, allow; else conflict
        const existing = snap.data();
        if (!existing || existing.orderId !== redemption.orderId) {
          throw new Error('Promo already redeemed for a different order');
        }
        return; // same order, same idempotency
      }
      tx.set(ref, toDoc(redemption));
    });
  }

  async getByOrderId(orderId: EntityId): Promise<{ promoId: EntityId; redeemedAt: string } | null> {
    const snap = await this.collection.where('orderId', '==', orderId).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    if (!doc) return null;
    const data = doc.data();
    if (!data) return null;
    return { promoId: data.promoId as EntityId, redeemedAt: data.redeemedAt as string };
  }

  async countByPromo(promoId: EntityId): Promise<number> {
    const snap = await this.collection.where('promoId', '==', promoId).count().get();
    return snap.data().count;
  }

  async countByPromoAndUser(promoId: EntityId, userId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('promoId', '==', promoId)
      .where('userId', '==', userId)
      .count()
      .get();
    return snap.data().count;
  }
}

function toDoc(redemption: {
  id: EntityId;
  promoId: EntityId;
  orderId: EntityId;
  userId: EntityId | null;
  redeemedAt: string;
}): DocumentData {
  return {
    id: redemption.id,
    promoId: redemption.promoId,
    orderId: redemption.orderId,
    userId: redemption.userId,
    redeemedAt: redemption.redeemedAt,
  };
}
