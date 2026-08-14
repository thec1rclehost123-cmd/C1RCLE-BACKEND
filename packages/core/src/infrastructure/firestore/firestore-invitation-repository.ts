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
    const snap = await this.collection
      .where('organizationId', '==', organizationId)
      .where('email', '==', normalizeEmail(email))
      .where('status', '==', 'pending')
      .limit(10)
      .get();

    for (const doc of snap.docs) {
      const invitation = toInvitation(doc.data());
      // `status === 'pending'` in storage can still be *effectively* expired;
      // the time check is authoritative so a lapsed row never blocks a re-invite.
      if (effectiveInvitationStatus(invitation) === 'pending') return invitation;
    }
    return null;
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
