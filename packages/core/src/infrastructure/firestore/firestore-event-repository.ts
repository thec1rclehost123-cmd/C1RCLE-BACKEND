import { VersionConflictError } from '../../domain/errors.js';

import { compareAndSet } from './compare-and-set.js';
import { outboxDocument } from './firestore-outbox-store.js';
import { paginateQuery } from './pagination.js';

import type { DomainEvent } from '../../domain/events.js';
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

  async getBySlug(slug: string): Promise<Event | null> {
    const snap = await this.collection.where('slug', '==', slug).limit(1).get();
    const doc = snap.docs[0];
    return doc ? toEvent(doc.data()) : null;
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    const base = this.collection.where('organizationId', '==', organizationId);
    return paginateQuery(base, query, toEvent);
  }

  async listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    const base = this.collection.where('venueId', '==', venueId);
    return paginateQuery(base, query, toEvent);
  }

  async listAll(query: PaginationQuery): Promise<Page<Event>> {
    return paginateQuery(this.collection, query, toEvent);
  }

  async listPublic(query: PaginationQuery): Promise<Page<Event>> {
    const base = this.collection.where('isPublic', '==', true);
    return paginateQuery(base, query, toEvent);
  }

  async listUpcomingPublic(startAtOrAfter: string, limit: number): Promise<Event[]> {
    const snap = await this.collection
      .where('isPublic', '==', true)
      .where('startAt', '>=', startAtOrAfter)
      .orderBy('startAt', 'asc')
      .limit(limit)
      .get();
    return snap.docs.map((doc) => toEvent(doc.data()));
  }

  async save(event: Event, _tx?: TxContext | null, outboxEvent?: DomainEvent): Promise<void> {
    if (!outboxEvent) {
      await compareAndSet(this.db, this.collection, event, toDoc);
      return;
    }
    const ref = this.collection.doc(event.id);
    const outboxRef = this.db.collection('v2_outbox').doc(outboxEvent.id);
    await this.db.runTransaction(async (tx) => {
      const [stored, queued] = await Promise.all([tx.get(ref), tx.get(outboxRef)]);
      const storedVersion = Number(stored.data()?.version ?? 0);
      if (event.version > 1 && (!stored.exists || storedVersion !== event.version - 1)) {
        throw new VersionConflictError(event.version - 1, storedVersion);
      }
      tx.set(ref, toDoc(event));
      if (!queued.exists) tx.create(outboxRef, outboxDocument(outboxEvent));
    });
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
    ...(data.entryRules ? { entryRules: data.entryRules as NonNullable<Event['entryRules']> } : {}),
    ...(data.media ? { media: data.media as NonNullable<Event['media']> } : {}),
    imageUrl: (data.imageUrl as string | null) ?? null,
    privateImageStoragePath: (data.privateImageStoragePath as string | null | undefined) ?? null,
    startAt: data.startAt as string,
    endAt: (data.endAt as string | null) ?? null,
    status: data.status as Event['status'],
    ...(data.postponement
      ? { postponement: data.postponement as NonNullable<Event['postponement']> }
      : {}),
    isPublic: data.isPublic as boolean,
    visibilityMode: (data.visibilityMode as Event['visibilityMode'] | undefined) ?? 'public',
    addressDisclosure: data.addressDisclosure as Event['addressDisclosure'] | undefined,
    tags: data.tags as string[],
    startingPricePaise: (data.startingPricePaise as number | null) ?? null,
    isFree: data.isFree as boolean,
    cancellationReason: (data.cancellationReason as string | null) ?? null,
    ...(data.refundPolicy
      ? { refundPolicy: data.refundPolicy as NonNullable<Event['refundPolicy']> }
      : {}),
    ...(typeof data.lastMaterialChangeAt === 'string'
      ? { lastMaterialChangeAt: data.lastMaterialChangeAt }
      : {}),
    compensation: (data.compensation as Event['compensation']) ?? null,
    // Documents written before the field existed read as "not configured",
    // which is exactly what `null` already means here.
    capacity: (data.capacity as number | null | undefined) ?? null,
    adminOverride: (data.adminOverride as boolean | undefined) ?? false,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
