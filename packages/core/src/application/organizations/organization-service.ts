import {
  OrganizationNotFoundError,
  ForbiddenError,
  InvalidOperationError,
  VersionConflictError,
} from '../../domain/errors.js';
import {
  createOrganization,
  addMember,
  updateOrganization,
  updateMemberRole,
  removeMember,
  suspendOrganization,
  acceptInvitation,
  createInvitation,
  normalizeEmail,
  revokeInvitation,
} from '../../domain/models/organization.js';
import { requireOrgAccess, emit } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  Organization,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationProps,
  Capability,
} from '../../domain/models/organization.js';
import type { OrganizationRepository, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateOrganizationCommand {
  name: string;
  slug: string;
  settings?: { name?: string; timezone?: string };
}

export interface InviteMemberCommand {
  organizationId: EntityId;
  userId: EntityId;
  role: OrganizationMember['role'];
  capabilities?: Capability[];
}

export interface UpdateOrganizationCommand {
  organizationId: EntityId;
  actor: ActorContext;
  /** Expected version for optimistic locking; `null` skips the check. */
  expectedVersion: number | null;
  props: OrganizationProps;
}

export interface CreateInvitationCommand {
  organizationId: EntityId;
  email: string;
  role: OrganizationMember['role'];
  capabilities?: Capability[];
}

export interface AcceptInvitationCommand {
  invitationId: EntityId;
  /** The user accepting — taken from the session, never from the request body. */
  userId: EntityId;
}

export class OrganizationService {
  constructor(private deps: ServiceDeps) {}

  private get repo(): OrganizationRepository {
    return this.deps.repositories.organizations;
  }

  async create(actor: ActorContext, command: CreateOrganizationCommand): Promise<Organization> {
    const now = this.deps.config.clock.now();
    const org = createOrganization({
      id: this.deps.config.ids(),
      name: command.name,
      slug: command.slug,
      ownerId: actor.userId,
      settings: command.settings,
      now,
    });
    await this.repo.save(org);
    this.deps.logger.info('organization.created', { organizationId: org.id });
    await emit(this.deps, actor, org.id, 'organization.created', {
      name: org.name,
      slug: org.slug,
    });
    return org;
  }

  async get(actor: ActorContext, organizationId: EntityId): Promise<Organization> {
    requireOrgAccess(actor, organizationId);
    const org = await this.repo.getById(organizationId);
    if (!org) throw new OrganizationNotFoundError(organizationId);
    return org;
  }

  async list(actor: ActorContext, query: PaginationQuery) {
    return this.repo.listForMember(actor.userId, query);
  }

  async listMembers(actor: ActorContext, organizationId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, organizationId);
    const org = await this.repo.getById(organizationId);
    if (!org) throw new OrganizationNotFoundError(organizationId);
    return this.repo.listMembers(organizationId, query);
  }

  async inviteMember(actor: ActorContext, command: InviteMemberCommand): Promise<Organization> {
    const { organizationId, userId, role, capabilities } = command;
    requireOrgAccess(actor, organizationId);
    const org = await this.repo.getById(organizationId);
    if (!org) throw new OrganizationNotFoundError(organizationId);

    const now = this.deps.config.clock.now();
    const updated = addMember(org, { userId, role, capabilities, invitedBy: actor.userId, now });
    await this.repo.save(updated);
    return updated;
  }

  async update(actor: ActorContext, command: UpdateOrganizationCommand): Promise<Organization> {
    const { organizationId } = command;
    requireOrgAccess(actor, organizationId);
    const org = await this.repo.getById(organizationId);
    if (!org) throw new OrganizationNotFoundError(organizationId);

    if (command.expectedVersion !== null && org.version !== command.expectedVersion) {
      throw new VersionConflictError(command.expectedVersion, org.version);
    }

    const updated = updateOrganization(org, command.props, this.deps.config.clock.now());
    if (updated === org) return org; // no-op, no write
    await this.repo.save(updated);
    await emit(this.deps, actor, updated.id, 'organization.updated', {
      name: updated.name,
      slug: updated.slug,
    });
    return updated;
  }

  async changeRole(
    actor: ActorContext,
    organizationId: EntityId,
    userId: EntityId,
    role: OrganizationMember['role'],
  ): Promise<Organization> {
    requireOrgAccess(actor, organizationId);
    const org = await this.repo.getById(organizationId);
    if (!org) throw new OrganizationNotFoundError(organizationId);
    const updated = updateMemberRole(org, userId, role, this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }

  async removeMember(
    actor: ActorContext,
    organizationId: EntityId,
    userId: EntityId,
  ): Promise<Organization> {
    requireOrgAccess(actor, organizationId);
    const org = await this.repo.getById(organizationId);
    if (!org) throw new OrganizationNotFoundError(organizationId);
    const updated = removeMember(org, userId, this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }

  /* ─── Invitations ────────────────────────────────────────────────────────
   * A pending invitation is the state between "invited" and "joined".
   * `inviteMember` (immediate membership) stays for the internal case where
   * the user id is already known; invitations are for people who may not have
   * an account yet, so they are addressed by email.
   */

  async listInvitations(actor: ActorContext, organizationId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, organizationId);
    return this.deps.repositories.invitations.listByOrganization(organizationId, query);
  }

  async createInvitation(
    actor: ActorContext,
    command: CreateInvitationCommand,
  ): Promise<OrganizationInvitation> {
    requireOrgAccess(actor, command.organizationId);
    const org = await this.repo.getById(command.organizationId);
    if (!org) throw new OrganizationNotFoundError(command.organizationId);

    const email = normalizeEmail(command.email);
    // Two live invitations for one address would let the same person join
    // twice with different roles depending on which link they clicked.
    const existing = await this.deps.repositories.invitations.findPendingByEmail(
      command.organizationId,
      email,
    );
    if (existing) {
      throw new InvalidOperationError('An invitation for this email is already pending');
    }

    const invitation = createInvitation({
      id: this.deps.config.ids(),
      organizationId: command.organizationId,
      email,
      role: command.role,
      capabilities: command.capabilities,
      invitedBy: actor.userId,
      now: this.deps.config.clock.now(),
    });
    await this.deps.repositories.invitations.save(invitation);
    this.deps.logger.info('organization.invitation_created', {
      organizationId: org.id,
      invitationId: invitation.id,
    });
    return invitation;
  }

  async revokeInvitation(
    actor: ActorContext,
    invitationId: EntityId,
  ): Promise<OrganizationInvitation> {
    const invitation = await this.fetchOwnedInvitation(actor, invitationId);
    const revoked = revokeInvitation(invitation, this.deps.config.clock.now());
    await this.deps.repositories.invitations.save(revoked);
    return revoked;
  }

  /**
   * Accepts an invitation, adding the member and closing the invitation
   * together. The two writes are ordered so a failure leaves the invitation
   * still pending (retryable) rather than a member with no record of joining.
   */
  async acceptInvitation(
    actor: ActorContext,
    command: AcceptInvitationCommand,
  ): Promise<Organization> {
    const invitation = await this.deps.repositories.invitations.getById(command.invitationId);
    // Cross-tenant and missing collapse to the same answer — no oracle.
    if (!invitation) throw new OrganizationNotFoundError(command.invitationId);

    const org = await this.repo.getById(invitation.organizationId);
    if (!org) throw new OrganizationNotFoundError(invitation.organizationId);

    const result = acceptInvitation(org, invitation, command.userId, this.deps.config.clock.now());
    await this.repo.save(result.organization);
    await this.deps.repositories.invitations.save(result.invitation);
    this.deps.logger.info('organization.invitation_accepted', {
      organizationId: org.id,
      invitationId: invitation.id,
    });
    return result.organization;
  }

  private async fetchOwnedInvitation(
    actor: ActorContext,
    invitationId: EntityId,
  ): Promise<OrganizationInvitation> {
    const invitation = await this.deps.repositories.invitations.getById(invitationId);
    if (!invitation || invitation.organizationId !== actor.organizationId) {
      throw new OrganizationNotFoundError(invitationId);
    }
    return invitation;
  }

  async suspend(actor: ActorContext, organizationId: EntityId): Promise<Organization> {
    requireOrgAccess(actor, organizationId);
    if (actor.role !== 'admin' && actor.role !== 'owner') {
      throw new ForbiddenError('Only admins can suspend an organization');
    }
    const org = await this.repo.getById(organizationId);
    if (!org) throw new OrganizationNotFoundError(organizationId);
    const updated = suspendOrganization(org, this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }
}
