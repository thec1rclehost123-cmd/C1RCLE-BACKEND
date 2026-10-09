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
  effectiveInvitationStatus,
  normalizeEmail,
  revokeInvitation,
} from '../../domain/models/organization.js';
import { displayNameForInviteEmail } from '../../domain/ports/staff-credentials.js';
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

  /**
   * The caller's own effectively-pending invitations, across orgs. The
   * session email is the only authority — no org scope applies, which is
   * what lets a freshly-provisioned invitee (zero memberships) discover the
   * invite instead of landing on onboarding with nowhere to go.
   */
  async listMyInvitations(email: string): Promise<OrganizationInvitation[]> {
    const normalized = normalizeEmail(email);
    if (!normalized.includes('@')) {
      throw new InvalidOperationError('A valid email address is required');
    }
    const items = await this.deps.repositories.invitations.listPendingByEmail(normalized);
    return items.filter((invitation) => effectiveInvitationStatus(invitation) === 'pending');
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
    // Inviting a current member produces a pending invitation that serves no
    // purpose — fail fast so the manager hears about it now instead of the
    // invitee hitting a dead end on the accept screen. Fail-open on lookup
    // errors: the idempotent accept is the backstop.
    const existingUserId = await this.deps.userDirectory
      .findUserIdByEmail(email)
      .catch((error: unknown) => {
        this.deps.logger.warn('organization.invitation_member_check_failed', {
          organizationId: org.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    if (existingUserId && org.members.some((m) => m.userId === existingUserId)) {
      throw new InvalidOperationError('User is already a member of this organization');
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
    // Provision a login for brand-new addresses: the invite email carries
    // sign-in credentials for the invited role, and the account must rotate
    // them on first login. Addresses that already have an account are never
    // touched — they sign in as usual and just accept the invite.
    // Provisioning failure must not roll back the invitation (fail-open):
    // the manager still sees it as pending and the invitee can accept from
    // the dashboard.
    let temporaryPassword: string | null = null;
    try {
      const provision = await this.deps.credentialProvisioner.provisionLogin(
        email,
        displayNameForInviteEmail(email),
      );
      if (provision.created && provision.temporaryPassword && provision.userId) {
        await this.deps.rotationStore.setRequired(provision.userId, true);
        temporaryPassword = provision.temporaryPassword;
      }
    } catch (error) {
      this.deps.logger.warn('organization.invitation_credential_failed', {
        organizationId: org.id,
        invitationId: invitation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // The invitation is real whether or not the email leaves the building: a
    // mail outage must not roll back (or block) the invite — the manager still
    // sees it as pending and the invitee can accept from the dashboard.
    try {
      const dashboardUrl = this.deps.config.partnerDashboardUrl?.replace(/\/$/, '');
      // The accept page is the flow's front door: it signs the invitee in
      // (email prefilled from `?email=`, a login-form hint only) and finishes
      // the accept itself once the first-login rotation is done.
      const acceptPath = `/invitations/${invitation.id}/accept?email=${encodeURIComponent(email)}`;
      await this.deps.emailSender.sendStaffInvitationEmail({
        to: email,
        orgName: org.name,
        role: invitation.role,
        capabilities: [...invitation.capabilities],
        expiresAt: invitation.expiresAt,
        ...(dashboardUrl ? { acceptUrl: `${dashboardUrl}${acceptPath}` } : {}),
        ...(temporaryPassword ? { temporaryPassword } : {}),
      });
    } catch (error) {
      this.deps.logger.warn('organization.invitation_email_failed', {
        organizationId: org.id,
        invitationId: invitation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
   * When the accepter is already a member the domain returns the org by
   * reference (no state changed) — repositories enforce compare-and-set, so
   * a no-op save would 409 and must be skipped.
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
    if (result.organization !== org) {
      await this.repo.save(result.organization);
    }
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
