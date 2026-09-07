import { VersionConflictError } from '../../domain/errors.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Payout, PayoutStatus } from '../../domain/models/payout.js';
import type { Page, PaginationQuery, PayoutRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const PAYOUT_COLLECTION = 'v2_payouts';

export class FirestorePayoutRepository implements PayoutRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(PAYOUT_COLLECTION);
  }

  async create(payout: Payout): Promise<Payout> {
    await this.collection.doc(payout.id).set(toDoc(payout));
    return payout;
  }

  async findById(id: EntityId): Promise<Payout | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toPayout(data) : null;
  }

  async save(payout: Payout): Promise<Payout> {
    const ref = this.collection.doc(payout.id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data) {
        const existing = toPayout(data);
        if (existing.version !== payout.version - 1) {
          throw new VersionConflictError(payout.version - 1, existing.version);
        }
      }
      tx.set(ref, toDoc(payout));
      return payout;
    });
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Payout>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toPayout);
  }

  async sumPaidByOrganization(organizationId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('organizationId', '==', organizationId)
      .where('status', '==', 'paid')
      .get();
    return snap.docs.reduce((sum, doc) => sum + (doc.data().amount as number), 0);
  }

  async sumRequestedOrProcessingByOrganization(organizationId: EntityId): Promise<number> {
    const snap = await this.collection.where('organizationId', '==', organizationId).get();
    return snap.docs
      .map((doc) => toPayout(doc.data()))
      .filter((p) => p.status === 'requested' || p.status === 'processing')
      .reduce((sum, p) => sum + p.amount, 0);
  }
}

function toDoc(payout: Payout): DocumentData {
  return {
    id: payout.id,
    organizationId: payout.organizationId,
    bankAccountId: payout.bankAccountId,
    amount: payout.amount,
    status: payout.status,
    failureReason: payout.failureReason,
    requestedBy: payout.requestedBy,
    processedAt: payout.processedAt,
    version: payout.version,
    createdAt: payout.createdAt,
    updatedAt: payout.updatedAt,
  };
}

function toPayout(data: DocumentData): Payout {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    bankAccountId: data.bankAccountId as string,
    amount: data.amount as number,
    status: data.status as PayoutStatus,
    failureReason: data.failureReason as string | null,
    requestedBy: data.requestedBy as string,
    processedAt: data.processedAt as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
