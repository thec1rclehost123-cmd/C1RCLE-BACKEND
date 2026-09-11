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
 * Amount-tiered approval, same thresholds as v1: under ₹500 settles
 * immediately (0 approvers), under ₹5,000 needs one admin's sign-off, at or
 * above ₹5,000 needs two. A request whose order already has a redeemed
 * (checked-in) entitlement never auto-settles, even under ₹500 — v1's own
 * rule: you cannot auto-refund a ticket that already got someone through
 * the door. `hasRedeemedEntitlement` is passed in at creation rather than
 * looked up here; this model stays pure and has no repository access.
 *
 * This is deliberately its own entity, not routed through
 * `admin-authority`'s propose→resolve — that mechanism is a fixed
 * one-proposer/one-resolver pair, and a ₹5,000+ refund needs an N-approver
 * accumulator (0, 1, or 2 depending on amount), not a binary approve/reject.
 */

export type AdminRefundRequestStatus = 'pending' | 'approved' | 'rejected' | 'settled' | 'failed';

export interface AdminRefundApproval {
  adminId: EntityId;
  approvedAt: string;
}

export interface AdminRefundRequest extends VersionedEntity {
  id: EntityId;
  orderId: EntityId;
  organizationId: EntityId;
  /** Paise. Must not exceed the order's refundable balance at request time. */
  amountPaise: number;
  requestedBy: EntityId;
  reason: string;
  /** 0 (auto), 1, or 2 — fixed at creation from the amount tier. */
  approversRequired: number;
  approvals: AdminRefundApproval[];
  status: AdminRefundRequestStatus;
  rejectedBy: EntityId | null;
  rejectionReason: string | null;
  /** The payment provider's refund id, set once settlement succeeds. */
  providerRefundId: string | null;
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
  /** Whether any entitlement on this order has already been scanned. */
  hasRedeemedEntitlement: boolean;
  now?: Date;
}

/** v1's exact thresholds, in paise: under ₹500, under ₹5,000, at or above. */
const AUTO_APPROVE_CEILING_PAISE = 50_000;
const SINGLE_APPROVER_CEILING_PAISE = 500_000;

export function approversRequiredFor(amountPaise: number, hasRedeemedEntitlement: boolean): number {
  if (amountPaise < AUTO_APPROVE_CEILING_PAISE) {
    // A checked-in ticket can never auto-settle, regardless of amount.
    return hasRedeemedEntitlement ? 1 : 0;
  }
  if (amountPaise < SINGLE_APPROVER_CEILING_PAISE) return 1;
  return 2;
}

export function createRefundRequest(input: CreateAdminRefundRequestInput): AdminRefundRequest {
  if (input.amountPaise <= 0) {
    throw new InvalidOperationError('Refund amount must be positive');
  }
  if (input.reason.trim().length === 0) {
    throw new InvalidOperationError('A refund request requires a reason');
  }
  const approversRequired = approversRequiredFor(input.amountPaise, input.hasRedeemedEntitlement);

  return {
    id: input.id,
    orderId: input.orderId,
    organizationId: input.organizationId,
    amountPaise: input.amountPaise,
    requestedBy: input.requestedBy,
    reason: input.reason.trim(),
    approversRequired,
    approvals: [],
    // Zero approvers required means it's ready to settle the moment it's
    // created — `pending` would be misleading (nothing is actually pending).
    status: approversRequired === 0 ? 'approved' : 'pending',
    rejectedBy: null,
    rejectionReason: null,
    providerRefundId: null,
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
  if (!isFullyApproved(request)) {
    throw new InvalidOperationError('This refund request has not been approved yet');
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    status: 'settled',
    providerRefundId,
  };
}

/** Records a failed settlement attempt — the order is restored separately. */
export function markRefundFailed(
  request: AdminRefundRequest,
  reason: string,
  now?: Date,
): AdminRefundRequest {
  if (!isFullyApproved(request)) {
    throw new InvalidOperationError('This refund request has not been approved yet');
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    status: 'failed',
    failureReason: reason,
  };
}
