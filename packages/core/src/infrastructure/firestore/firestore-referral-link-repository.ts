import { normalizeReferralCode } from '../../domain/models/referral-link.js';

import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { ReferralLink } from '../../domain/models/referral-link.js';
import type {
  Page,
  PaginationQuery,
  ReferralLinkRepository,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_promoter_links';

/** Firestore adapter for `ReferralLinkRepository`. */
export class FirestoreReferralLinkRepository implements ReferralLinkRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(linkId: EntityId): Promise<ReferralLink | null> {
    const snap = await this.collection.doc(linkId).get();
    const data = snap.data();
    return data ? toLink(data) : null;
  }

  async findByCode(eventId: EntityId, code: string): Promise<ReferralLink | null> {
    const snap = await this.collection
      .where('eventId', '==', eventId)
      .where('code', '==', normalizeReferralCode(code))
      .limit(1)
      .get();
    const doc = snap.docs[0];
    return doc ? toLink(doc.data()) : null;
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<ReferralLink>> {
    const base = this.collection.where('eventId', '==', eventId).orderBy('createdAt');
    return paginateQuery(base, query, toLink);
  }

  async listByPromoter(promoterId: EntityId, query: PaginationQuery): Promise<Page<ReferralLink>> {
    const base = this.collection.where('promoterId', '==', promoterId).orderBy('createdAt');
    return paginateQuery(base, query, toLink);
  }

  async save(link: ReferralLink, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, link, (value) => ({ ...value }));
  }
}

function toLink(data: DocumentData): ReferralLink {
  return {
    id: data.id as string,
    eventId: data.eventId as string,
    promoterId: data.promoterId as string,
    organizationId: data.organizationId as string,
    code: data.code as string,
    label: data.label as string,
    isActive: data.isActive as boolean,
    clicks: (data.clicks ?? 0) as number,
    conversions: (data.conversions ?? 0) as number,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
