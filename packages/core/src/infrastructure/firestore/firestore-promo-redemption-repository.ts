import type { EntityId } from '../../domain/identity.js';
import type { PromoRedemptionRepository, TxContext } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_promo_redemptions';

/**
 * Firestore adapter for `PromoRedemptionRepository` (Phase 4).
 * Shared with Phase 3 event-catalog promo codes.
 */
export class FirestorePromoRedemptionRepository implements PromoRedemptionRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
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
