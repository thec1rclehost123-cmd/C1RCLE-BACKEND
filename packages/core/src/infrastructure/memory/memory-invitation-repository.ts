import { OrganizationNotFoundError } from '../../domain/errors.js';
import {
  acceptInvitationForRecipient,
  effectiveInvitationStatus,
  normalizeEmail,
} from '../../domain/models/organization.js';

import type { MemoryOrganizationRepository } from './memory-repositories.js';
import type { MemoryUserAccountRepository } from './memory-user-account-repository.js';
import type { EntityId } from '../../domain/identity.js';
import type { Organization, OrganizationInvitation } from '../../domain/models/organization.js';
import type {
  InvitationRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';

/**
 * ─── In-memory invitation repository (dev/test adapter) ──────────────────────
 * Mirrors the other Memory* repos: Map-backed, offset cursor, zero infra
 * imports.
 */
export class MemoryInvitationRepository implements InvitationRepository {
  invitations = new Map<EntityId, OrganizationInvitation>();

  constructor(
    private readonly organizations?: MemoryOrganizationRepository,
    private readonly users?: MemoryUserAccountRepository,
  ) {}

  async acceptForUser(
    invitationId: EntityId,
    userId: EntityId,
    now: () => Date,
  ): Promise<Organization> {
    // No await between snapshot, validation and writes: one event-loop turn.
    const invitation = this.invitations.get(invitationId);
    if (!invitation) throw new OrganizationNotFoundError(invitationId);
    const organizations = this.organizations;
    const org = organizations?.organizations.get(invitation.organizationId);
    if (!org || !organizations) throw new OrganizationNotFoundError(invitation.organizationId);
    const result = acceptInvitationForRecipient(
      org,
      invitation,
      userId,
      this.users?.users.get(userId) ?? null,
      now(),
    );
    organizations.organizations.set(org.id, result.organization);
    for (const member of result.organization.members) {
      organizations.members.set(`${org.id}|${member.userId}`, member);
    }
    this.invitations.set(invitation.id, result.invitation);
    return result.organization;
  }

  async getById(invitationId: EntityId): Promise<OrganizationInvitation | null> {
    return this.invitations.get(invitationId) ?? null;
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<OrganizationInvitation>> {
    const all = [...this.invitations.values()]
      .filter((invitation) => invitation.organizationId === organizationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const items = all.slice(offset, offset + query.limit);
    const next = offset + items.length;
    return {
      items,
      total: all.length,
      nextCursor: next < all.length ? String(next) : null,
    };
  }
  async findPendingByEmail(
    organizationId: EntityId,
    email: string,
  ): Promise<OrganizationInvitation | null> {
    const wanted = normalizeEmail(email);
    for (const invitation of this.invitations.values()) {
      if (invitation.organizationId !== organizationId) continue;
      if (invitation.email !== wanted) continue;
      // An expired invitation does not block a fresh one — `effectiveStatus`
      // is what a caller sees, so it is what "already pending" must mean.
      if (effectiveInvitationStatus(invitation) === 'pending') return invitation;
    }
    return null;
  }

  async listPendingByEmail(email: string): Promise<OrganizationInvitation[]> {
    const wanted = normalizeEmail(email);
    return [...this.invitations.values()]
      .filter(
        (invitation) =>
          invitation.email === wanted && effectiveInvitationStatus(invitation) === 'pending',
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async save(invitation: OrganizationInvitation, _tx?: TxContext | null): Promise<void> {
    this.invitations.set(invitation.id, invitation);
  }
}
