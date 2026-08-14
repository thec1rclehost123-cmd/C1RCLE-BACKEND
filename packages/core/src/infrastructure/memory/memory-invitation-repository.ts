import { effectiveInvitationStatus, normalizeEmail } from '../../domain/models/organization.js';

import type { EntityId } from '../../domain/identity.js';
import type { OrganizationInvitation } from '../../domain/models/organization.js';
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

  async save(invitation: OrganizationInvitation, _tx?: TxContext | null): Promise<void> {
    this.invitations.set(invitation.id, invitation);
  }
}
