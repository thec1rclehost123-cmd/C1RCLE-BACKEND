import {
  OrganizationNotFoundError,
  ForbiddenError,
  VersionConflictError,
} from '../../domain/errors.js';
import {
  createOrganization,
  addMember,
  updateOrganization,
  updateMemberRole,
  removeMember,
  suspendOrganization,
} from '../../domain/models/organization.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  Organization,
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
