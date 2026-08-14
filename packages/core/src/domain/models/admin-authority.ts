import { ForbiddenError, InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Tiered admin authority (Phase 2) ────────────────────────────────────────
 *
 * Ported from v1 `apps/admin-console/lib/server/adminStore.js`, which the
 * roadmap calls out as "genuinely good, port verbatim".
 *
 * Three tiers, by consequence rather than by job title:
 *  - **TIER1** — any admin may act; the action is merely logged.
 *  - **TIER2** — reserved to senior roles. Reversible but costly: approving a
 *    partner, suspending a venue, refunding money, running a payout batch.
 *  - **TIER3** — `super` only, AND under dual control: provisioning another
 *    admin, adjusting commission, freezing payouts. These either change who
 *    holds power or move money at scale.
 *
 * Dual control is the part worth keeping most: a TIER3 action is *proposed* by
 * one admin and *resolved* by a different one. A proposer resolving their own
 * proposal would make the second signature theatre.
 */

export type AdminRole = 'super' | 'admin' | 'ops' | 'finance' | 'support';

export type AdminAction =
  // TIER2
  | 'ONBOARDING_APPROVE'
  | 'VENUE_SUSPEND'
  | 'FINANCIAL_REFUND'
  | 'PAYOUT_BATCH_RUN'
  // TIER3
  | 'ADMIN_PROVISION'
  | 'COMMISSION_ADJUST'
  | 'PAYOUT_FREEZE';

export type AuthorityTier = 1 | 2 | 3;

const TIER2_ACTIONS: readonly AdminAction[] = [
  'ONBOARDING_APPROVE',
  'VENUE_SUSPEND',
  'FINANCIAL_REFUND',
  'PAYOUT_BATCH_RUN',
];

const TIER3_ACTIONS: readonly AdminAction[] = [
  'ADMIN_PROVISION',
  'COMMISSION_ADJUST',
  'PAYOUT_FREEZE',
];

/** Roles permitted at TIER2 (v1: `[super, admin, ops, finance]`). */
const TIER2_ROLES: readonly AdminRole[] = ['super', 'admin', 'ops', 'finance'];

export function tierOf(action: AdminAction): AuthorityTier {
  if (TIER3_ACTIONS.includes(action)) return 3;
  if (TIER2_ACTIONS.includes(action)) return 2;
  return 1;
}

/** Whether a role may *initiate* an action at all. */
export function canInitiate(role: AdminRole, action: AdminAction): boolean {
  const tier = tierOf(action);
  if (tier === 3) return role === 'super';
  if (tier === 2) return TIER2_ROLES.includes(role);
  return true;
}

/** True when the action additionally requires a second admin to resolve it. */
export function requiresDualControl(action: AdminAction): boolean {
  return tierOf(action) === 3;
}

export function assertCanInitiate(role: AdminRole, action: AdminAction): void {
  if (!canInitiate(role, action)) {
    throw new ForbiddenError(`Role "${role}" cannot perform ${action} (tier ${tierOf(action)})`);
  }
}

/* ─── The admin record itself ──────────────────────────────────────────────── */

/**
 * A platform operator. Deliberately *not* an `OrganizationMember`: an org role
 * ("owner of Venue X") and a platform role ("can approve any onboarding") are
 * different authorities, and letting one imply the other is how a partner ends
 * up able to approve themselves.
 *
 * Keyed by the auth user id, so there is exactly one admin record per human.
 */
export interface PlatformAdmin extends VersionedEntity {
  /** The Better Auth user id. */
  id: EntityId;
  email: string;
  role: AdminRole;
  /**
   * Revocation is a flag rather than a delete: audit records reference the
   * admin id, and a deleted admin would leave those unattributable.
   */
  isActive: boolean;
}

export interface CreatePlatformAdminInput {
  id: EntityId;
  email: string;
  role: AdminRole;
  now?: Date;
}

export function createPlatformAdmin(input: CreatePlatformAdminInput): PlatformAdmin {
  return {
    id: input.id,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    isActive: true,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

export function deactivatePlatformAdmin(admin: PlatformAdmin, now?: Date): PlatformAdmin {
  if (!admin.isActive) return admin;
  return { ...bumpVersion(admin, now ?? new Date()), isActive: false };
}

/* ─── Proposed actions (dual control) ──────────────────────────────────────── */

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ProposedAction extends VersionedEntity {
  id: EntityId;
  action: AdminAction;
  proposedBy: EntityId;
  /** Free-form justification, required — a TIER3 act must be explicable. */
  reason: string;
  /** The command payload the action will run with, frozen at proposal time. */
  payload: Record<string, unknown>;
  status: ProposalStatus;
  resolvedBy: EntityId | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
}

export interface ProposeActionInput {
  id: EntityId;
  action: AdminAction;
  proposedBy: EntityId;
  proposerRole: AdminRole;
  reason: string;
  payload?: Record<string, unknown>;
  now?: Date;
}

export function proposeAction(input: ProposeActionInput): ProposedAction {
  assertCanInitiate(input.proposerRole, input.action);
  if (!requiresDualControl(input.action)) {
    // Proposing a lower-tier action would imply a second signature that the
    // system does not actually require — misleading in the audit trail.
    throw new InvalidOperationError(`${input.action} does not require dual control`);
  }
  if (input.reason.trim().length === 0) {
    throw new InvalidOperationError('A proposed action requires a reason');
  }

  return {
    id: input.id,
    action: input.action,
    proposedBy: input.proposedBy,
    reason: input.reason.trim(),
    payload: input.payload ?? {},
    status: 'pending',
    resolvedBy: null,
    resolvedAt: null,
    resolutionReason: null,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

export interface ResolveActionInput {
  resolvedBy: EntityId;
  resolverRole: AdminRole;
  reason?: string;
  now?: Date;
}

function resolve(
  proposal: ProposedAction,
  status: Extract<ProposalStatus, 'approved' | 'rejected'>,
  input: ResolveActionInput,
): ProposedAction {
  if (proposal.status !== 'pending') {
    throw new InvalidOperationError(`This proposal is already ${proposal.status}`);
  }
  // The whole point of dual control: a second pair of eyes, not the same pair.
  if (input.resolvedBy === proposal.proposedBy) {
    throw new ForbiddenError('A proposal cannot be resolved by the admin who raised it');
  }
  assertCanInitiate(input.resolverRole, proposal.action);

  const now = input.now ?? new Date();
  return {
    ...bumpVersion(proposal, now),
    status,
    resolvedBy: input.resolvedBy,
    resolvedAt: now.toISOString(),
    resolutionReason: input.reason?.trim() ?? null,
  };
}

export function approveProposal(
  proposal: ProposedAction,
  input: ResolveActionInput,
): ProposedAction {
  return resolve(proposal, 'approved', input);
}

export function rejectProposal(
  proposal: ProposedAction,
  input: ResolveActionInput,
): ProposedAction {
  return resolve(proposal, 'rejected', input);
}

/** The proposer withdrawing their own proposal — the one self-service path. */
export function cancelProposal(
  proposal: ProposedAction,
  cancelledBy: EntityId,
  now?: Date,
): ProposedAction {
  if (proposal.status !== 'pending') {
    throw new InvalidOperationError(`This proposal is already ${proposal.status}`);
  }
  if (cancelledBy !== proposal.proposedBy) {
    throw new ForbiddenError('Only the proposer can cancel their proposal');
  }
  return { ...bumpVersion(proposal, now ?? new Date()), status: 'cancelled' };
}

/** Whether an approved proposal may now be executed. */
export function isExecutable(proposal: ProposedAction): boolean {
  return proposal.status === 'approved';
}
