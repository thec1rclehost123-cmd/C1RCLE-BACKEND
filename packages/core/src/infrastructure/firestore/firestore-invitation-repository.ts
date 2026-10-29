import { effectiveInvitationStatus, normalizeEmail } from '../../domain/models/organization.js';

import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { OrganizationInvitation } from '../../domain/models/organization.js';
import type {
  InvitationRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_organization_invitations';

/**
 * Firestore adapter for `InvitationRepository`. Same interface as the memory
 * adapter — swapping drivers changes no service or route.
 */
export class FirestoreInvitationRepository implements InvitationRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(invitationId: EntityId): Promise<OrganizationInvitation | null> {
    const snap = await this.collection.doc(invitationId).get();
    const data = snap.data();
    return data ? toInvitation(data) : null;
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<OrganizationInvitation>> {
    const base = this.collection.where('organizationId', '==', organizationId).orderBy('createdAt');
    return paginateQuery(base, query, toInvitation);
  }

  async findPendingByEmail(
    organizationId: EntityId,
    email: string,
  ): Promise<OrganizationInvitation | null> {
    // Single equality filter only (automatic single-field index): the previous
    // triple-where (`organizationId` + `email` + `status`) demands a composite
    // index that was never deployed, so every invite on the firestore driver
    // failed with FAILED_PRECONDITION → 500. Email is the selective filter;
    // org + status + expiry are checked in code (same pattern as
    // `listPendingByEmail` below).
    const wanted = normalizeEmail(email);
    const snap = await this.collection.where('email', '==', wanted).limit(50).get();

    for (const doc of snap.docs) {
      const invitation = toInvitation(doc.data());
      if (invitation.organizationId !== organizationId) continue;
      if (invitation.status !== 'pending') continue;
      // `status === 'pending'` in storage can still be *effectively* expired;
      // the time check is authoritative so a lapsed row never blocks a re-invite.
      if (effectiveInvitationStatus(invitation) === 'pending') return invitation;
    }
    return null;
  }

  async listPendingByEmail(email: string): Promise<OrganizationInvitation[]> {
    // Single equality filter only (automatic single-field index): pairing
    // filters or adding `orderBy` would demand a new composite index at
    // deploy time. Fifty rows filter and sort trivially in code.
    const snap = await this.collection.where('email', '==', normalizeEmail(email)).limit(50).get();

    const pending: OrganizationInvitation[] = [];
    for (const doc of snap.docs) {
      const invitation = toInvitation(doc.data());
      if (invitation.status !== 'pending') continue;
      if (effectiveInvitationStatus(invitation) === 'pending') pending.push(invitation);
    }
    return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async save(invitation: OrganizationInvitation, _tx?: TxContext | null): Promise<void> {
    // Compare-and-set: a write of version N must find N-1 (see compare-and-set.ts).
    await compareAndSet(this.db, this.collection, invitation, (value) => ({ ...value }));
  }
}

function toInvitation(data: DocumentData): OrganizationInvitation {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    email: data.email as string,
    role: data.role as OrganizationInvitation['role'],
    capabilities: (data.capabilities ?? []) as OrganizationInvitation['capabilities'],
    status: data.status as OrganizationInvitation['status'],
    invitedBy: data.invitedBy as string,
    expiresAt: data.expiresAt as string,
    acceptedAt: (data.acceptedAt ?? null) as string | null,
    acceptedBy: (data.acceptedBy ?? null) as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
