import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Entitlement, EntitlementStatus } from '../../domain/models/entitlement.js';
import type {
  EntitlementRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_entitlements';

/**
 * Firestore adapter for `EntitlementRepository` (Phase 4).
 * Same interface as `MemoryEntitlementRepository`.
 * `orderId` index is denormalized for fulfilment verification.
 */
export class FirestoreEntitlementRepository implements EntitlementRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(entitlementId: EntityId): Promise<Entitlement | null> {
    const snap = await this.collection.doc(entitlementId).get();
    const data = snap.data();
    return data ? toEntitlement(data) : null;
  }

  async getByOrderId(orderId: EntityId): Promise<Entitlement[]> {
    const snap = await this.collection.where('orderId', '==', orderId).get();
    return snap.docs.map((doc) => toEntitlement(doc.data()));
  }

  async listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>> {
    const base = this.collection.where('userId', '==', userId).orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toEntitlement);
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>> {
    const base = this.collection.where('eventId', '==', eventId).orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toEntitlement);
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Entitlement>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toEntitlement);
  }

  async save(entitlement: Entitlement, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, entitlement, toDoc);
  }

  async saveMany(entitlements: Entitlement[], _tx?: TxContext | null): Promise<void> {
    const batch = this.db.batch();
    for (const e of entitlements) {
      const ref = this.collection.doc(e.id);
      // For creates (version 1), just set; for updates, use compare-and-set in transaction
      if (e.version <= 1) {
        batch.set(ref, toDoc(e));
      } else {
        // For version > 1, we need a transaction with compare-and-set
        // This is a simplified approach - in production you'd want a proper transaction
        await compareAndSet(this.db, this.collection, e, toDoc);
      }
    }
    await batch.commit();
  }

  async countValidByTier(tierId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('tierId', '==', tierId)
      .where('status', '==', 'valid')
      .count()
      .get();
    return snap.data().count;
  }
}

function toDoc(entitlement: Entitlement): DocumentData {
  return {
    id: entitlement.id,
    orderId: entitlement.orderId,
    eventId: entitlement.eventId,
    organizationId: entitlement.organizationId,
    tierId: entitlement.tierId,
    tierName: entitlement.tierName,
    userId: entitlement.userId,
    holderName: entitlement.holderName,
    status: entitlement.status,
    scanCountAllowed: entitlement.scanCountAllowed,
    scanCount: entitlement.scanCount,
    scannedAt: entitlement.scannedAt,
    version: entitlement.version,
    createdAt: entitlement.createdAt,
    updatedAt: entitlement.updatedAt,
  };
}

function toEntitlement(data: DocumentData): Entitlement {
  return {
    id: data.id as string,
    orderId: data.orderId as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    tierId: data.tierId as string,
    tierName: data.tierName as string,
    userId: data.userId as string | null,
    holderName: data.holderName as string,
    status: data.status as EntitlementStatus,
    scanCountAllowed: data.scanCountAllowed as number,
    scanCount: data.scanCount as number,
    scannedAt: data.scannedAt as string[],
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
