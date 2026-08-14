import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { SlotRequest } from '../../domain/models/venue.js';
import type {
  SlotRequestRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_slot_requests';

/** Firestore adapter for `SlotRequestRepository` (B12). */
export class FirestoreSlotRequestRepository implements SlotRequestRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(slotRequestId: EntityId): Promise<SlotRequest | null> {
    const snap = await this.collection.doc(slotRequestId).get();
    const data = snap.data();
    return data ? toSlotRequest(data) : null;
  }

  async listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<SlotRequest>> {
    const base = this.collection.where('venueId', '==', venueId);
    return paginateQuery(base, query, toSlotRequest);
  }

  async save(request: SlotRequest, _tx?: TxContext | null): Promise<void> {
    // Compare-and-set: a write of version N must find N-1 (see compare-and-set.ts).
    await compareAndSet(this.db, this.collection, request, toDoc);
  }
}

function toDoc(request: SlotRequest): DocumentData {
  return { ...request };
}

function toSlotRequest(data: DocumentData): SlotRequest {
  return {
    id: data.id as string,
    venueId: data.venueId as string,
    eventId: (data.eventId as string | null) ?? null,
    hostId: data.hostId as string,
    status: data.status as SlotRequest['status'],
    message: data.message as string | undefined,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
