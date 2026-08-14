import { isConnectionLive } from '../../domain/models/promoter-connection.js';

import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { PromoterConnection } from '../../domain/models/promoter-connection.js';
import type {
  Page,
  PaginationQuery,
  PromoterConnectionRepository,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_promoter_connections';

/**
 * Firestore adapter. `partyIds` is a denormalized query index (not domain
 * state) so one `array-contains` serves "either side", as with partnerships.
 */
export class FirestorePromoterConnectionRepository implements PromoterConnectionRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(connectionId: EntityId): Promise<PromoterConnection | null> {
    const snap = await this.collection.doc(connectionId).get();
    const data = snap.data();
    return data ? toConnection(data) : null;
  }

  async findByPair(promoterId: EntityId, targetId: EntityId): Promise<PromoterConnection | null> {
    const snap = await this.collection
      .where('promoterId', '==', promoterId)
      .where('targetId', '==', targetId)
      .get();
    const matches = snap.docs
      .map((doc) => toConnection(doc.data()))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return matches.find(isConnectionLive) ?? matches[0] ?? null;
  }

  async listForOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<PromoterConnection>> {
    const base = this.collection
      .where('partyIds', 'array-contains', organizationId)
      .orderBy('createdAt');
    return paginateQuery(base, query, toConnection);
  }

  async save(connection: PromoterConnection, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, connection, toDoc);
  }
}

function toDoc(connection: PromoterConnection): DocumentData {
  return { ...connection, partyIds: [connection.promoterId, connection.targetId] };
}

function toConnection(data: DocumentData): PromoterConnection {
  return {
    id: data.id as string,
    promoterId: data.promoterId as string,
    targetId: data.targetId as string,
    targetType: data.targetType as PromoterConnection['targetType'],
    initiatedBy: data.initiatedBy as PromoterConnection['initiatedBy'],
    status: data.status as PromoterConnection['status'],
    message: (data.message ?? null) as string | null,
    resolutionReason: (data.resolutionReason ?? null) as string | null,
    resolvedAt: (data.resolvedAt ?? null) as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
