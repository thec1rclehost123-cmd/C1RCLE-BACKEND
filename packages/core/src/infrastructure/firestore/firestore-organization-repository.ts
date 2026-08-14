import { compareAndSet } from './compare-and-set.js';
import { sliceArray, paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Organization, OrganizationMember } from '../../domain/models/organization.js';
import type {
  OrganizationRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_organizations';

/**
 * Firestore adapter for `OrganizationRepository` (B12). Same interface as
 * `MemoryOrganizationRepository` — no route/service change to swap this in.
 * `memberIds` is a denormalized array field (not part of the domain model)
 * written purely so `listForMember` can use an `array-contains` query;
 * stripped back out on read via explicit field mapping.
 */
export class FirestoreOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(organizationId: EntityId): Promise<Organization | null> {
    const snap = await this.collection.doc(organizationId).get();
    const data = snap.data();
    return data ? toOrganization(data) : null;
  }

  async listForMember(userId: EntityId, query: PaginationQuery): Promise<Page<Organization>> {
    const base = this.collection.where('memberIds', 'array-contains', userId);
    return paginateQuery(base, query, toOrganization);
  }

  async listMembers(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<OrganizationMember>> {
    const org = await this.getById(organizationId);
    return sliceArray(org ? org.members : [], query);
  }

  async getMember(organizationId: EntityId, userId: EntityId): Promise<OrganizationMember | null> {
    const org = await this.getById(organizationId);
    return org?.members.find((m) => m.userId === userId) ?? null;
  }

  async save(org: Organization, _tx?: TxContext | null): Promise<void> {
    // Compare-and-set: a write of version N must find N-1 (see compare-and-set.ts).
    await compareAndSet(this.db, this.collection, org, toDoc);
  }

  async delete(organizationId: EntityId, _tx?: TxContext | null): Promise<void> {
    await this.collection.doc(organizationId).delete();
  }
}

function toDoc(org: Organization): DocumentData {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    ownerId: org.ownerId,
    members: org.members,
    memberIds: org.members.map((m) => m.userId),
    settings: org.settings,
    status: org.status,
    version: org.version,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

function toOrganization(data: DocumentData): Organization {
  return {
    id: data.id as string,
    name: data.name as string,
    slug: data.slug as string,
    ownerId: data.ownerId as string,
    members: data.members as OrganizationMember[],
    settings: data.settings as Organization['settings'],
    status: data.status as Organization['status'],
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
