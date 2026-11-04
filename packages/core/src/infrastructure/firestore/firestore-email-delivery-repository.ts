import type { EntityId } from '../../domain/identity.js';
import type { EmailDelivery, EmailDeliveryRepository } from '../../domain/ports/email-delivery.js';
import type { Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_email_deliveries';

export class FirestoreEmailDeliveryRepository implements EmailDeliveryRepository {
  constructor(private readonly db: Firestore) {}

  async get(id: EntityId): Promise<EmailDelivery | null> {
    const snapshot = await this.db.collection(COLLECTION).doc(id).get();
    return snapshot.exists ? (snapshot.data() as EmailDelivery) : null;
  }

  async createIfAbsent(delivery: EmailDelivery): Promise<EmailDelivery> {
    const ref = this.db.collection(COLLECTION).doc(delivery.id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) return snapshot.data() as EmailDelivery;
      tx.create(ref, delivery);
      return delivery;
    });
  }

  async claim(id: EntityId, now: number, leaseExpiresAt: number): Promise<boolean> {
    const ref = this.db.collection(COLLECTION).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const data = snapshot.data() as EmailDelivery;
      if (
        data.status === 'sent' ||
        (data.status === 'sending' && (data.leaseExpiresAt ?? 0) > now)
      ) {
        return false;
      }
      tx.update(ref, {
        status: 'sending',
        retryCount: data.retryCount + 1,
        leaseExpiresAt,
        updatedAt: now,
      });
      return true;
    });
  }

  async markSent(id: EntityId, providerMessageId: string, now: number): Promise<void> {
    await this.db.collection(COLLECTION).doc(id).update({
      status: 'sent',
      providerMessageId,
      sentAt: now,
      updatedAt: now,
      lastError: null,
      leaseExpiresAt: null,
    });
  }

  async markFailed(id: EntityId, safeError: string, now: number): Promise<void> {
    await this.db
      .collection(COLLECTION)
      .doc(id)
      .update({
        status: 'failed',
        lastError: safeError.slice(0, 160),
        updatedAt: now,
        leaseExpiresAt: null,
      });
  }

  async listForAggregate(aggregateId: EntityId, limit = 50): Promise<EmailDelivery[]> {
    const snapshot = await this.db
      .collection(COLLECTION)
      .where('aggregateId', '==', aggregateId)
      .limit(limit)
      .get();
    return snapshot.docs
      .map((document) => document.data() as EmailDelivery)
      .sort((left, right) => right.createdAt - left.createdAt);
  }
}
