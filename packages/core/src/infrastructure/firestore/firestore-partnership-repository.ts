import { isLive } from '../../domain/models/partnership.js';

import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Partnership } from '../../domain/models/partnership.js';
import type {
  Page,
  PaginationQuery,
  PartnershipRepository,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_partnerships';

/**
 * Firestore adapter for `PartnershipRepository`.
 *
 * `partyIds` is a denormalized array (not part of the domain model) written so
 * `listForOrganization` can use one `array-contains` query instead of two
 * queries plus a client-side merge — a partnership is reachable from either
 * side, and Firestore has no OR across different fields.
 */
export class FirestorePartnershipRepository implements PartnershipRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(partnershipId: EntityId): Promise<Partnership | null> {
    const snap = await this.collection.doc(partnershipId).get();
    const data = snap.data();
    return data ? toPartnership(data) : null;
  }

  async findByPair(hostOrganizationId: EntityId, venueId: EntityId): Promise<Partnership | null> {
    const snap = await this.collection
      .where('hostOrganizationId', '==', hostOrganizationId)
      .where('venueId', '==', venueId)
      .get();

    const matches = snap.docs
      .map((doc) => toPartnership(doc.data()))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    // A live row wins; otherwise the most recent resolved one, so a caller can
    // still see that the pair is blocked.
    return matches.find(isLive) ?? matches[0] ?? null;
  }

  async listForOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Partnership>> {
    const base = this.collection
      .where('partyIds', 'array-contains', organizationId)
      .orderBy('createdAt');
    return paginateQuery(base, query, toPartnership);
  }

  async save(partnership: Partnership, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, partnership, toDoc);
  }
}

function toDoc(partnership: Partnership): DocumentData {
  return {
    ...partnership,
    // Query index only — stripped on read so it never leaks into the model.
    partyIds: [partnership.hostOrganizationId, partnership.venueOrganizationId],
  };
}

function toPartnership(data: DocumentData): Partnership {
  return {
    id: data.id as string,
    hostOrganizationId: data.hostOrganizationId as string,
    venueOrganizationId: data.venueOrganizationId as string,
    venueId: data.venueId as string,
    initiatedBy: data.initiatedBy as Partnership['initiatedBy'],
    status: data.status as Partnership['status'],
    message: (data.message ?? null) as string | null,
    resolutionReason: (data.resolutionReason ?? null) as string | null,
    resolvedAt: (data.resolvedAt ?? null) as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
