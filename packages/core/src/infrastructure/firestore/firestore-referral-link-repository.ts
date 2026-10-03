import { FieldValue } from 'firebase-admin/firestore';

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
const CODE_COLLECTION = 'v2_promoter_tracking_codes';
const PROMOTER_CODE_COLLECTION = 'v2_promoter_codes';
const VANITY_COLLECTION = 'v2_promoter_vanity_aliases';

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

  async findByCodeGlobal(code: string): Promise<ReferralLink | null> {
    const snap = await this.collection
      .where('code', '==', normalizeReferralCode(code))
      .limit(1)
      .get();
    const doc = snap.docs[0];
    return doc ? toLink(doc.data()) : null;
  }

  async findAnyByPromoter(promoterId: EntityId): Promise<ReferralLink | null> {
    const snap = await this.collection.where('promoterId', '==', promoterId).limit(1).get();
    const doc = snap.docs[0];
    return doc ? toLink(doc.data()) : null;
  }

  async findByVanity(prefix: string, slug: string): Promise<ReferralLink | null> {
    const snap = await this.collection
      .where('vanityPrefix', '==', prefix)
      .where('vanitySlug', '==', slug)
      .where('isActive', '==', true)
      .limit(1)
      .get();
    const doc = snap.docs[0];
    return doc ? toLink(doc.data()) : null;
  }

  async claimVanityAlias(prefix: string, slug: string, linkId: EntityId): Promise<boolean> {
    const ref = this.db.collection(VANITY_COLLECTION).doc(`${prefix}_${slug}`);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const owner = snap.get('linkId') as string | undefined;
      if (owner && owner !== linkId) return false;
      if (!owner) tx.create(ref, { prefix, slug, linkId, createdAt: new Date().toISOString() });
      return true;
    });
  }

  async claimGlobalCode(code: string, promoterId: EntityId): Promise<boolean> {
    const normalized = normalizeReferralCode(code);
    const ref = this.db.collection(CODE_COLLECTION).doc(normalized);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const owner = snap.get('promoterId') as string | undefined;
      if (owner && owner !== promoterId) return false;
      if (!owner)
        tx.create(ref, { code: normalized, promoterId, createdAt: new Date().toISOString() });
      return true;
    });
  }

  async getOrCreatePromoterCode(
    promoterId: EntityId,
    proposedCode: string,
  ): Promise<string | null> {
    const normalized = normalizeReferralCode(proposedCode);
    const promoterRef = this.db.collection(PROMOTER_CODE_COLLECTION).doc(promoterId);
    return this.db.runTransaction(async (tx) => {
      const promoterSnap = await tx.get(promoterRef);
      const current = promoterSnap.get('code') as string | undefined;
      const selected = current ?? normalized;
      const codeRef = this.db.collection(CODE_COLLECTION).doc(selected);
      const codeSnap = await tx.get(codeRef);
      const owner = codeSnap.get('promoterId') as string | undefined;
      if (owner && owner !== promoterId) return null;
      if (!current)
        tx.create(promoterRef, { promoterId, code: selected, createdAt: new Date().toISOString() });
      if (!owner)
        tx.create(codeRef, { code: selected, promoterId, createdAt: new Date().toISOString() });
      return selected;
    });
  }

  async recordClick(linkId: EntityId): Promise<boolean> {
    const ref = this.collection.doc(linkId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('isActive') !== true) return false;
      tx.update(ref, { clicks: FieldValue.increment(1), updatedAt: new Date().toISOString() });
      return true;
    });
  }

  async recordSale(
    linkId: EntityId,
    orderId: EntityId,
    revenuePaise: number,
    commissionPaise: number,
  ): Promise<void> {
    const ref = this.collection.doc(linkId);
    const saleRef = ref.collection('sales').doc(orderId);
    await this.db.runTransaction(async (tx) => {
      const [linkSnap, saleSnap] = await Promise.all([tx.get(ref), tx.get(saleRef)]);
      if (!linkSnap.exists || saleSnap.exists) return;
      tx.create(saleRef, {
        orderId,
        revenuePaise,
        commissionPaise,
        createdAt: new Date().toISOString(),
      });
      tx.update(ref, {
        conversions: FieldValue.increment(1),
        revenuePaise: FieldValue.increment(revenuePaise),
        commissionPaise: FieldValue.increment(commissionPaise),
        updatedAt: new Date().toISOString(),
      });
    });
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
    assignmentId: (data.assignmentId ?? null) as string | null,
    assignmentVersion: (data.assignmentVersion ?? null) as number | null,
    termsSnapshot: (data.termsSnapshot ?? null) as ReferralLink['termsSnapshot'],
    attributionSignature: (data.attributionSignature ?? null) as string | null,
    eventTitle: (data.eventTitle ?? '') as string,
    campaignLabel: (data.campaignLabel ?? data.label ?? 'organic') as string,
    vanityPrefix: (data.vanityPrefix ?? '') as string,
    vanitySlug: (data.vanitySlug ?? null) as string | null,
    code: data.code as string,
    label: data.label as string,
    isActive: data.isActive as boolean,
    clicks: (data.clicks ?? 0) as number,
    conversions: (data.conversions ?? 0) as number,
    revenuePaise: (data.revenuePaise ?? 0) as number,
    commissionPaise: (data.commissionPaise ?? 0) as number,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
