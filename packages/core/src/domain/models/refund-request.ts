import { ForbiddenError, InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Admin refund request (Phase 6 admin) ────────────────────────────────────
 *
 * Ported from v1's real money logic — which lived in its API gateway
 * (`apps/api-gateway/src/routes/v1/refunds.ts`), not its admin console (the
 * console's own refund path just flipped a status flag with no balance
 * check, no provider call, and no approval; see `order.ts`'s
 * `restoreOrderAfterRefundFailure` comment for the bug that path shipped).
 *
 * Amount-tiered approval, same thresholds as v1: under ₹500 needs zero
 * admin sign-offs (auto-*approved*, not auto-*settled* — see below), under
 * ₹5,000 needs one admin's sign-off, at or above ₹5,000 needs two. A
 * request whose order already has a redeemed (checked-in) entitlement
 * always needs at least one sign-off, even under ₹500 — v1's own rule: you
 * cannot wave through a refund for a ticket that already got someone
 * through the door. `hasRedeemedEntitlement` is passed in at creation
 * rather than looked up here; this model stays pure and has no repository
 * access.
 *
 * `approved` is NOT `settled`: approval only satisfies the human-control
 * threshold. `RefundService.executeRefund` is the separate money-moving
 * action that claims execution, records the provider result, and then applies
 * the internal journal, order, and entitlement effects.
 *
 * This is deliberately its own entity, not routed through
 * `admin-authority`'s propose→resolve — that mechanism is a fixed
 * one-proposer/one-resolver pair, and a ₹5,000+ refund needs an N-approver
 * accumulator (0, 1, or 2 depending on amount), not a binary approve/reject.
 */

export type AdminRefundRequestStatus =
  'pending' | 'approved' | 'executing' | 'rejected' | 'settled' | 'failed';

export interface AdminRefundApproval {
  adminId: EntityId;
  approvedAt: string;
}

export type RefundScope = 'amount_only' | 'ticket_lines';

export interface RefundTicketLine {
  tierId: EntityId;
  quantity: number;
}

export interface AdminRefundRequest extends VersionedEntity {
  id: EntityId;
  orderId: EntityId;
  organizationId: EntityId;
  /** Paise. Must not exceed the order's refundable balance at request time. */
  amountPaise: number;
  requestedBy: EntityId;
  reason: string;
  /**
   * `amount_only` adjusts money without selectively revoking admission rights.
   * A full refund still voids every entitlement. `ticket_lines` freezes the
   * exact entitlement ids at request time so retries cannot choose a different
   * ticket or revoke more than once.
   */
  scope: RefundScope;
  ticketLines: RefundTicketLine[];
  targetEntitlementIds: EntityId[];
  /** 0 (auto), 1, or 2 — fixed at creation from the amount tier. */
  approversRequired: number;
  approvals: AdminRefundApproval[];
  status: AdminRefundRequestStatus;
  rejectedBy: EntityId | null;
  rejectionReason: string | null;
  /** The payment provider's refund id, set once settlement succeeds. */
  providerRefundId: string | null;
  providerStatus: string | null;
  executionIdempotencyKey: string;
  executionAttempts: number;
  /** Why settlement failed, if it did — surfaced for a human to retry or escalate. */
  failureReason: string | null;
}

export interface CreateAdminRefundRequestInput {
  id: EntityId;
  orderId: EntityId;
  organizationId: EntityId;
  amountPaise: number;
  requestedBy: EntityId;
  reason: string;
  scope?: RefundScope;
  ticketLines?: RefundTicketLine[];
  targetEntitlementIds?: EntityId[];
  /** Whether any entitlement on this order has already been scanned. */
  hasRedeemedEntitlement: boolean;
  /** Platform-wide refund thresholds (fetched from PlatformSettings). */
  thresholds?: RefundThresholds;
  now?: Date;
}

/** v1's exact thresholds, in paise: under ₹500, under ₹5,000, at or above. */
export const AUTO_APPROVE_CEILING_PAISE = 50_000;
export const SINGLE_APPROVER_CEILING_PAISE = 500_000;

export interface RefundThresholds {
  singleApproverCeilingPaise: number;
  dualApproverCeilingPaise: number;
}

export function approversRequiredFor(
  amountPaise: number,
  hasRedeemedEntitlement: boolean,
  thresholds?: RefundThresholds,
): number {
  const singleCeiling = thresholds?.singleApproverCeilingPaise ?? AUTO_APPROVE_CEILING_PAISE;
  const dualCeiling = thresholds?.dualApproverCeilingPaise ?? SINGLE_APPROVER_CEILING_PAISE;
  if (amountPaise < singleCeiling) {
    // A checked-in ticket can never auto-settle, regardless of amount.
    return hasRedeemedEntitlement ? 1 : 0;
  }
  if (amountPaise < dualCeiling) return 1;
  return 2;
}

export function createRefundRequest(input: CreateAdminRefundRequestInput): AdminRefundRequest {
  if (input.amountPaise <= 0) {
    throw new InvalidOperationError('Refund amount must be positive');
  }
  if (input.reason.trim().length === 0) {
    throw new InvalidOperationError('A refund request requires a reason');
  }
  const scope = input.scope ?? 'amount_only';
  const ticketLines = input.ticketLines ?? [];
  const targetEntitlementIds = input.targetEntitlementIds ?? [];
  if (scope === 'amount_only' && (ticketLines.length > 0 || targetEntitlementIds.length > 0)) {
    throw new InvalidOperationError('Amount-only refunds cannot select tickets');
  }
  if (scope === 'ticket_lines') {
    if (ticketLines.length === 0 || targetEntitlementIds.length === 0) {
      throw new InvalidOperationError('Ticket-line refunds require selected tickets');
    }
    const quantity = ticketLines.reduce((sum, line) => {
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
        throw new InvalidOperationError('Refund ticket quantities must be positive integers');
      }
      return sum + line.quantity;
    }, 0);
    if (quantity !== targetEntitlementIds.length) {
      throw new InvalidOperationError('Selected entitlement count does not match ticket quantity');
    }
    if (new Set(targetEntitlementIds).size !== targetEntitlementIds.length) {
      throw new InvalidOperationError('A ticket cannot be selected twice');
    }
  }
  const approversRequired = approversRequiredFor(
    input.amountPaise,
    input.hasRedeemedEntitlement,
    input.thresholds,
  );

  return {
    id: input.id,
    orderId: input.orderId,
    organizationId: input.organizationId,
    amountPaise: input.amountPaise,
    requestedBy: input.requestedBy,
    reason: input.reason.trim(),
    scope,
    ticketLines,
    targetEntitlementIds,
    approversRequired,
    approvals: [],
    // Zero approvers required means no human sign-off is waited on —
    // `pending` would be misleading (nothing is actually pending). This is
    // NOT a settlement signal; execution remains an explicit later action.
    status: approversRequired === 0 ? 'approved' : 'pending',
    rejectedBy: null,
    rejectionReason: null,
    providerRefundId: null,
    providerStatus: null,
    executionIdempotencyKey: `refund:${input.id}`,
    executionAttempts: 0,
    failureReason: null,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/** True once enough admins have signed off (or none were required). */
export function isFullyApproved(request: AdminRefundRequest): boolean {
  return request.status === 'approved';
}

export function approveRefundRequest(
  request: AdminRefundRequest,
  adminId: EntityId,
  now?: Date,
): AdminRefundRequest {
  if (request.status !== 'pending') {
    throw new InvalidOperationError(`This refund request is already ${request.status}`);
  }
  // Stronger than v1: the requester cannot count as one of their own
  // approvers, not just "no duplicate approval" — the same principle
  // admin-authority's dual control applies to TIER3 proposals.
  if (adminId === request.requestedBy) {
    throw new ForbiddenError('The admin who requested this refund cannot approve it');
  }
  if (request.approvals.some((approval) => approval.adminId === adminId)) {
    throw new ForbiddenError('This admin has already approved this refund request');
  }

  const at = now ?? new Date();
  const approvals = [...request.approvals, { adminId, approvedAt: at.toISOString() }];
  const fullyApproved = approvals.length >= request.approversRequired;
  return {
    ...bumpVersion(request, at),
    approvals,
    status: fullyApproved ? 'approved' : 'pending',
  };
}

export function rejectRefundRequest(
  request: AdminRefundRequest,
  adminId: EntityId,
  reason: string,
  now?: Date,
): AdminRefundRequest {
  if (request.status !== 'pending') {
    throw new InvalidOperationError(`This refund request is already ${request.status}`);
  }
  if (reason.trim().length === 0) {
    throw new InvalidOperationError('Rejecting a refund request requires a reason');
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    status: 'rejected',
    rejectedBy: adminId,
    rejectionReason: reason.trim(),
  };
}

/** Records successful settlement with the payment provider. */
export function markRefundSettled(
  request: AdminRefundRequest,
  providerRefundId: string,
  now?: Date,
): AdminRefundRequest {
  if (request.status !== 'executing') {
    throw new InvalidOperationError('This refund request is not executing');
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    status: 'settled',
    providerRefundId,
    providerStatus: 'processed',
    failureReason: null,
  };
}

/** Records a failed settlement attempt — the order is restored separately. */
export function markRefundFailed(
  request: AdminRefundRequest,
  reason: string,
  now?: Date,
): AdminRefundRequest {
  if (request.status !== 'executing') {
    throw new InvalidOperationError('This refund request is not executing');
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    status: 'failed',
    failureReason: reason,
  };
}

/** Keeps an ambiguous provider outcome locked for webhook/reconciliation. */
export function markRefundExecutionUncertain(
  request: AdminRefundRequest,
  reason: string,
  now?: Date,
): AdminRefundRequest {
  if (request.status !== 'executing') {
    throw new InvalidOperationError('This refund request is not executing');
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    failureReason: reason.trim().slice(0, 500),
  };
}

/** Claims provider execution. Optimistic repository save makes this single-winner. */
export function beginRefundExecution(request: AdminRefundRequest, now?: Date): AdminRefundRequest {
  if (request.status !== 'approved' && request.status !== 'failed') {
    throw new InvalidOperationError(`This refund request is ${request.status}, not executable`);
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    status: 'executing',
    executionAttempts: request.executionAttempts + 1,
    failureReason: null,
  };
}

/** Persists the authoritative provider response before internal side effects. */
export function recordRefundProviderFact(
  request: AdminRefundRequest,
  providerRefundId: string,
  providerStatus: string,
  now?: Date,
): AdminRefundRequest {
  if (request.status !== 'executing') {
    throw new InvalidOperationError('This refund request is not executing');
  }
  if (!providerRefundId.trim() || !providerStatus.trim()) {
    throw new InvalidOperationError('Provider refund id and status are required');
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    providerRefundId,
    providerStatus,
  };
}
