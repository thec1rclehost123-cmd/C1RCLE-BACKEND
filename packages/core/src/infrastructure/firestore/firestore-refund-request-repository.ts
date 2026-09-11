import { VersionConflictError } from '../../domain/errors.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  AdminRefundRequest,
  AdminRefundRequestStatus,
} from '../../domain/models/refund-request.js';
import type {
  Page,
  PaginationQuery,
  AdminRefundRequestRepository,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';

const REFUND_REQUEST_COLLECTION = 'v2_refund_requests';

export class FirestoreRefundRequestRepository implements AdminRefundRequestRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(REFUND_REQUEST_COLLECTION);
  }

  async getById(id: EntityId): Promise<AdminRefundRequest | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toRefundRequest(data) : null;
  }

  async listByOrder(orderId: EntityId): Promise<AdminRefundRequest[]> {
    const snap = await this.collection
      .where('orderId', '==', orderId)
      .orderBy('createdAt', 'desc')
      .get();
    return snap.docs.map((doc) => toRefundRequest(doc.data()));
  }

  async listByStatus(
    status: AdminRefundRequestStatus | null,
    query: PaginationQuery,
  ): Promise<Page<AdminRefundRequest>> {
    const base: Query = status
      ? this.collection.where('status', '==', status).orderBy('createdAt', 'desc')
      : this.collection.orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toRefundRequest);
  }

  async save(request: AdminRefundRequest): Promise<void> {
    const ref = this.collection.doc(request.id);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data) {
        const existing = toRefundRequest(data);
        if (existing.version !== request.version - 1) {
          throw new VersionConflictError(request.version - 1, existing.version);
        }
      }
      tx.set(ref, toDoc(request));
    });
  }
}

function toDoc(request: AdminRefundRequest): DocumentData {
  return {
    id: request.id,
    orderId: request.orderId,
    organizationId: request.organizationId,
    amountPaise: request.amountPaise,
    requestedBy: request.requestedBy,
    reason: request.reason,
    approversRequired: request.approversRequired,
    approvals: request.approvals,
    status: request.status,
    rejectedBy: request.rejectedBy,
    rejectionReason: request.rejectionReason,
    providerRefundId: request.providerRefundId,
    failureReason: request.failureReason,
    version: request.version,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function toRefundRequest(data: DocumentData): AdminRefundRequest {
  return {
    id: data.id as string,
    orderId: data.orderId as string,
    organizationId: data.organizationId as string,
    amountPaise: data.amountPaise as number,
    requestedBy: data.requestedBy as string,
    reason: data.reason as string,
    approversRequired: data.approversRequired as number,
    approvals: data.approvals as AdminRefundRequest['approvals'],
    status: data.status as AdminRefundRequestStatus,
    rejectedBy: data.rejectedBy as string | null,
    rejectionReason: data.rejectionReason as string | null,
    providerRefundId: data.providerRefundId as string | null,
    failureReason: data.failureReason as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
