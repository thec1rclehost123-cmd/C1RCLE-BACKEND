import { VersionConflictError } from '../../domain/errors.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Dispute, DisputeStatus } from '../../domain/models/dispute.js';
import type { DisputeRepository, Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';

const DISPUTE_COLLECTION = 'v2_disputes';

export class FirestoreDisputeRepository implements DisputeRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(DISPUTE_COLLECTION);
  }

  async create(dispute: Dispute): Promise<Dispute> {
    await this.collection.doc(dispute.id).set(toDoc(dispute));
    return dispute;
  }

  async findById(id: EntityId): Promise<Dispute | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toDispute(data) : null;
  }

  async save(dispute: Dispute): Promise<Dispute> {
    const ref = this.collection.doc(dispute.id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data) {
        const existing = toDispute(data);
        if (existing.version !== dispute.version - 1) {
          throw new VersionConflictError(dispute.version - 1, existing.version);
        }
      }
      tx.set(ref, toDoc(dispute));
      return dispute;
    });
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery & { status?: DisputeStatus },
  ): Promise<Page<Dispute>> {
    let base: Query = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('createdAt', 'desc');
    if (query.status) {
      base = this.collection
        .where('organizationId', '==', organizationId)
        .where('status', '==', query.status)
        .orderBy('createdAt', 'desc');
    }
    return paginateQuery(base, query, toDispute);
  }
}

function toDoc(dispute: Dispute): DocumentData {
  return {
    id: dispute.id,
    organizationId: dispute.organizationId,
    orderId: dispute.orderId,
    ledgerEntryId: dispute.ledgerEntryId,
    raisedBy: dispute.raisedBy,
    reason: dispute.reason,
    amount: dispute.amount,
    status: dispute.status,
    resolutionNote: dispute.resolutionNote,
    resolvedAt: dispute.resolvedAt,
    version: dispute.version,
    createdAt: dispute.createdAt,
    updatedAt: dispute.updatedAt,
  };
}

function toDispute(data: DocumentData): Dispute {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    orderId: data.orderId as string,
    ledgerEntryId: data.ledgerEntryId as string | null,
    raisedBy: data.raisedBy as string,
    reason: data.reason as string,
    amount: data.amount as number,
    status: data.status as DisputeStatus,
    resolutionNote: data.resolutionNote as string | null,
    resolvedAt: data.resolvedAt as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
