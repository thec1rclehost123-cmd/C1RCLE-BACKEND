import {
  ForbiddenError,
  InvalidOperationError,
  ProposalNotFoundError,
  UnauthorizedError,
} from '../../domain/errors.js';
import {
  approveProposal,
  assertCanInitiate,
  cancelProposal,
  createPlatformAdmin,
  deactivatePlatformAdmin,
  isExecutable,
  proposeAction,
  rejectProposal,
  requiresDualControl,
} from '../../domain/models/admin-authority.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  AdminAction,
  AdminRole,
  PlatformAdmin,
  ProposalStatus,
  ProposedAction,
} from '../../domain/models/admin-authority.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Admin authority service (Phase 2) ───────────────────────────────────────
 *
 * The gate every privileged operation goes through. Three jobs, and nothing
 * else:
 *
 *  1. **Resolve** an auth user id to a platform admin — or refuse. Platform
 *     authority is never inferred from an organization role.
 *  2. **Authorize** an action against that admin's tier.
 *  3. **Record** what happened, with before/after state.
 *
 * TIER3 actions additionally route through propose→resolve, so no single
 * operator can provision an admin, move a commission rate or freeze payouts
 * alone.
 */

export interface ProposeCommand {
  action: AdminAction;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface AuditInput {
  action: string;
  targetType: string;
  targetId: EntityId;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason?: string | null;
}

export class AdminAuthorityService {
  constructor(private deps: ServiceDeps) {}

  private get admins() {
    return this.deps.repositories.platformAdmins;
  }

  private get proposals() {
    return this.deps.repositories.proposals;
  }

  /**
   * Resolves the caller as a platform admin.
   *
   * A deactivated admin is refused with the same error as a non-admin: once
   * authority is revoked, whether the account was *ever* an admin is not
   * something the caller needs told.
   */
  async requireAdmin(userId: EntityId): Promise<PlatformAdmin> {
    const admin = await this.admins.getById(userId);
    if (!admin || !admin.isActive) {
      throw new UnauthorizedError('Platform admin authority required');
    }
    return admin;
  }

  /** `requireAdmin` plus the tier check for one specific action. */
  async authorize(userId: EntityId, action: AdminAction): Promise<PlatformAdmin> {
    const admin = await this.requireAdmin(userId);
    assertCanInitiate(admin.role, action);
    return admin;
  }

  /** Writes the audit record for an action an admin has just performed. */
  async record(admin: PlatformAdmin, input: AuditInput): Promise<void> {
    await this.deps.adminAudit.append({
      id: this.deps.config.ids(),
      adminId: admin.id,
      adminRole: admin.role,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      reason: input.reason ?? null,
      occurredAt: this.deps.config.clock.now().getTime(),
    });
  }

  async listAudit(userId: EntityId, limit: number) {
    await this.requireAdmin(userId);
    return this.deps.adminAudit.listRecent(limit);
  }

  async listAuditForTarget(userId: EntityId, targetId: EntityId, limit: number) {
    await this.requireAdmin(userId);
    return this.deps.adminAudit.listForTarget(targetId, limit);
  }

  /* ─── Dual control ───────────────────────────────────────────────────────── */

  async propose(userId: EntityId, command: ProposeCommand): Promise<ProposedAction> {
    const admin = await this.requireAdmin(userId);
    const proposal = proposeAction({
      id: this.deps.config.ids(),
      action: command.action,
      proposedBy: admin.id,
      proposerRole: admin.role,
      reason: command.reason,
      payload: command.payload,
      now: this.deps.config.clock.now(),
    });
    await this.proposals.save(proposal);
    await this.record(admin, {
      action: `proposal.raise:${command.action}`,
      targetType: 'proposed_action',
      targetId: proposal.id,
      before: null,
      after: { action: proposal.action, status: proposal.status },
      reason: proposal.reason,
    });
    this.deps.logger.info('admin.proposal_raised', {
      proposalId: proposal.id,
      action: proposal.action,
    });
    return proposal;
  }

  async approve(userId: EntityId, proposalId: EntityId, reason?: string): Promise<ProposedAction> {
    return this.resolve(userId, proposalId, reason, approveProposal);
  }

  async reject(userId: EntityId, proposalId: EntityId, reason?: string): Promise<ProposedAction> {
    return this.resolve(userId, proposalId, reason, rejectProposal);
  }

  async cancel(userId: EntityId, proposalId: EntityId): Promise<ProposedAction> {
    const admin = await this.requireAdmin(userId);
    const proposal = await this.requireProposal(proposalId);
    const cancelled = cancelProposal(proposal, admin.id, this.deps.config.clock.now());
    await this.proposals.save(cancelled);
    await this.record(admin, {
      action: `proposal.cancel:${proposal.action}`,
      targetType: 'proposed_action',
      targetId: proposal.id,
      before: { status: proposal.status },
      after: { status: cancelled.status },
      reason: null,
    });
    return cancelled;
  }

  async listProposals(userId: EntityId, status: ProposalStatus | null, query: PaginationQuery) {
    await this.requireAdmin(userId);
    return this.proposals.listByStatus(status, query);
  }

  async getProposal(userId: EntityId, proposalId: EntityId): Promise<ProposedAction> {
    await this.requireAdmin(userId);
    return this.requireProposal(proposalId);
  }

  private async resolve(
    userId: EntityId,
    proposalId: EntityId,
    reason: string | undefined,
    apply: (
      proposal: ProposedAction,
      input: { resolvedBy: EntityId; resolverRole: AdminRole; reason?: string; now?: Date },
    ) => ProposedAction,
  ): Promise<ProposedAction> {
    const admin = await this.requireAdmin(userId);
    const proposal = await this.requireProposal(proposalId);
    // The self-approval refusal lives in the domain — see `admin-authority.ts`.
    const resolved = apply(proposal, {
      resolvedBy: admin.id,
      resolverRole: admin.role,
      reason,
      now: this.deps.config.clock.now(),
    });
    await this.proposals.save(resolved);
    await this.record(admin, {
      action: `proposal.${resolved.status}:${proposal.action}`,
      targetType: 'proposed_action',
      targetId: proposal.id,
      before: { status: proposal.status },
      after: { status: resolved.status },
      reason: resolved.resolutionReason,
    });
    this.deps.logger.info('admin.proposal_resolved', {
      proposalId: proposal.id,
      status: resolved.status,
    });
    return resolved;
  }

  private async requireProposal(proposalId: EntityId): Promise<ProposedAction> {
    const proposal = await this.proposals.getById(proposalId);
    if (!proposal) throw new ProposalNotFoundError(proposalId);
    return proposal;
  }

  /* ─── Admin provisioning (TIER3, executed from an approved proposal) ─────── */

  async listAdmins(userId: EntityId, query: PaginationQuery) {
    await this.requireAdmin(userId);
    return this.admins.list(query);
  }

  /**
   * Creates a platform admin. Deliberately takes a *proposal id* rather than
   * the new admin's details: `ADMIN_PROVISION` is TIER3, so the details must
   * already have been written down by one admin and approved by another. The
   * payload is read from the proposal, never from this call's arguments —
   * otherwise the executing admin could approve one thing and provision
   * something else.
   */
  async provisionAdminFromProposal(userId: EntityId, proposalId: EntityId): Promise<PlatformAdmin> {
    const admin = await this.authorize(userId, 'ADMIN_PROVISION');
    const proposal = await this.requireProposal(proposalId);
    if (proposal.action !== 'ADMIN_PROVISION') {
      throw new InvalidOperationError('This proposal does not provision an admin');
    }
    if (!isExecutable(proposal)) {
      throw new ForbiddenError('This proposal has not been approved by a second admin');
    }

    const { userId: newUserId, email, role } = readProvisionPayload(proposal.payload);
    const existing = await this.admins.getById(newUserId);
    if (existing?.isActive) {
      throw new InvalidOperationError('That user is already a platform admin');
    }

    const created = createPlatformAdmin({
      id: newUserId,
      email,
      role,
      now: this.deps.config.clock.now(),
    });
    // A previously-deactivated admin is re-created at the stored version so the
    // compare-and-set in the adapter still sees a coherent history.
    const next = existing ? { ...created, version: existing.version + 1 } : created;
    await this.admins.save(next);
    await this.record(admin, {
      action: 'ADMIN_PROVISION',
      targetType: 'platform_admin',
      targetId: next.id,
      before: existing ? { role: existing.role, isActive: existing.isActive } : null,
      after: { role: next.role, isActive: next.isActive },
      reason: proposal.reason,
    });
    return next;
  }

  /**
   * Revoking authority is *not* dual-controlled, on purpose: making it hard to
   * take authority away is the wrong failure mode when an account is
   * compromised. Granting it is the dangerous direction.
   */
  async revokeAdmin(userId: EntityId, targetUserId: EntityId): Promise<PlatformAdmin> {
    const admin = await this.requireAdmin(userId);
    if (admin.role !== 'super') {
      throw new ForbiddenError('Only a super admin can revoke platform authority');
    }
    if (admin.id === targetUserId) {
      // Locking the last super admin out of their own console is a real
      // outage; make it a deliberate two-person act instead.
      throw new InvalidOperationError('An admin cannot revoke their own authority');
    }
    const target = await this.admins.getById(targetUserId);
    if (!target) throw new InvalidOperationError(`No such admin: ${targetUserId}`);
    const revoked = deactivatePlatformAdmin(target, this.deps.config.clock.now());
    await this.admins.save(revoked);
    await this.record(admin, {
      action: 'ADMIN_REVOKE',
      targetType: 'platform_admin',
      targetId: target.id,
      before: { isActive: target.isActive },
      after: { isActive: revoked.isActive },
      reason: null,
    });
    return revoked;
  }

  /** True when this action must go through propose→resolve. */
  needsDualControl(action: AdminAction): boolean {
    return requiresDualControl(action);
  }
}

const ADMIN_ROLES: readonly AdminRole[] = ['super', 'admin', 'ops', 'finance', 'support'];

/**
 * Reads a proposal payload back out. Validated here rather than trusted,
 * because the payload was stored as an opaque bag and a malformed one would
 * otherwise become an admin record with a role of `undefined`.
 */
function readProvisionPayload(payload: Record<string, unknown>): {
  userId: EntityId;
  email: string;
  role: AdminRole;
} {
  const userId = payload.userId;
  const email = payload.email;
  const role = payload.role;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new InvalidOperationError('Proposal payload is missing `userId`');
  }
  if (typeof email !== 'string' || email.length === 0) {
    throw new InvalidOperationError('Proposal payload is missing `email`');
  }
  if (typeof role !== 'string' || !ADMIN_ROLES.includes(role as AdminRole)) {
    throw new InvalidOperationError('Proposal payload is missing a valid `role`');
  }
  return { userId, email, role: role as AdminRole };
}
