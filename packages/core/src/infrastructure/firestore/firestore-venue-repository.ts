import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Venue } from '../../domain/models/venue.js';
import type {
  VenueRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_venues';

/** Firestore adapter for `VenueRepository` (B12). */
export class FirestoreVenueRepository implements VenueRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(venueId: EntityId): Promise<Venue | null> {
    const snap = await this.collection.doc(venueId).get();
    const data = snap.data();
    return data ? toVenue(data) : null;
  }

  async getBySlug(slug: string, organizationId: EntityId): Promise<Venue | null> {
    const snap = await this.collection
      .where('organizationId', '==', organizationId)
      .where('public.slug', '==', slug)
      .limit(1)
      .get();
    const doc = snap.docs[0];
    return doc ? toVenue(doc.data()) : null;
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Venue>> {
    const base = this.collection.where('organizationId', '==', organizationId);
    return paginateQuery(base, query, toVenue);
  }

  async save(venue: Venue, _tx?: TxContext | null): Promise<void> {
    await this.collection.doc(venue.id).set(toDoc(venue));
  }
}

function toDoc(venue: Venue): DocumentData {
  return { ...venue };
}

function toVenue(data: DocumentData): Venue {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    ownerId: data.ownerId as string,
    status: data.status as Venue['status'],
    public: data.public as Venue['public'],
    private: data.private as Venue['private'],
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
