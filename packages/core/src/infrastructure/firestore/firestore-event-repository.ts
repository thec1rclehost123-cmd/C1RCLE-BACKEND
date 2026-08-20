import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type {
  EventRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_events';

/** Firestore adapter for `EventRepository` (B12). */
export class FirestoreEventRepository implements EventRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(eventId: EntityId): Promise<Event | null> {
    const snap = await this.collection.doc(eventId).get();
    const data = snap.data();
    return data ? toEvent(data) : null;
  }

  async findById(eventId: EntityId): Promise<Event | null> {
    const snap = await this.collection.doc(eventId).get();
    const data = snap.data();
    return data ? toEvent(data) : null;
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    const base = this.collection.where('organizationId', '==', organizationId);
    return paginateQuery(base, query, toEvent);
  }

  async listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    const base = this.collection.where('venueId', '==', venueId);
    return paginateQuery(base, query, toEvent);
  }

  async listPublic(query: PaginationQuery): Promise<Page<Event>> {
    const base = this.collection.where('isPublic', '==', true);
    return paginateQuery(base, query, toEvent);
  }

  async save(event: Event, _tx?: TxContext | null): Promise<void> {
    // Compare-and-set: a write of version N must find N-1 (see compare-and-set.ts).
    await compareAndSet(this.db, this.collection, event, toDoc);
  }

  async delete(eventId: EntityId, _tx?: TxContext | null): Promise<void> {
    await this.collection.doc(eventId).delete();
  }
}

function toDoc(event: Event): DocumentData {
  return { ...event };
}

function toEvent(data: DocumentData): Event {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    venueId: (data.venueId as string | null) ?? null,
    slug: data.slug as string,
    title: data.title as string,
    summary: data.summary as string,
    description: data.description as string,
    imageUrl: (data.imageUrl as string | null) ?? null,
    startAt: data.startAt as string,
    endAt: (data.endAt as string | null) ?? null,
    status: data.status as Event['status'],
    isPublic: data.isPublic as boolean,
    tags: data.tags as string[],
    startingPricePaise: (data.startingPricePaise as number | null) ?? null,
    isFree: data.isFree as boolean,
    cancellationReason: (data.cancellationReason as string | null) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
