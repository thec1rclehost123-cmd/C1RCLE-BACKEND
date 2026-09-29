import { InvalidOperationError, StateTransitionError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Platform safety report (Phase 7) ────────────────────────────────────────
 *
 * Ported from v1's report flow. v1's guest surface (`mobile-app`'s
 * `/social/report`, the only intake path) POSTed
 * `{ targetId, targetType, reason (category), details, metadata:{eventId,messageId} }`
 * to `/api/v1/social/report`, which persisted a `safety_reports` doc with
 * `{ reporterId, targetId, targetType:'user'|'event', reason, details?, status:
 * 'pending'|'reviewed'|'resolved'|'dismissed', createdAt }` and logged a
 * 5-report amendment hint once a target gathered 5+ reports. The v1
 * admin-console desk (`app/safety/page.jsx` over `adminStore.js`) listed those
 * docs with a **derived** priority (CRITICAL for the `safety` category, else
 * NORMAL), rendered `reporterEmail`, `reportedUserId` and a hardcoded
 * "Safety Rating 99.9%" stat, and fired two dispatcher verbs:
 * `USER_BAN` (against the reported user) and `SAFETY_REPORT_DISMISS` (writes
 * `dismissedAt`/`dismissedBy`/`status:'dismissed'`).
 *
 * What is new here (the v1-to-v2 honesty fixes):
 *
 *  - **A real review SLA.** The mobile flow promised "we'll review within 24
 *    hours"; v1 recorded nothing to back it. `reviewDueAt` is set now, and
 *    `overdue` is derived at read time — the desk can sort by it.
 *  - **A real safety metric.** v1's "Safety Rating 99.9%" was ornamental. The
 *    desk's `/stats` derives `resolutionRate` = resolved reports ÷ total from
 *    the live repository counts — no fabricated number.
 *  - **Attributed resolution.** `dismissed`/`actioned` keep `dismissedBy`/
 *    `actionedBy` and, for `actioned`, the discipline the operator states was
 *    applied (`action.type`/`action.ref`, e.g. `user_ban` + the ban/target id).
 *    The discipline verb itself (currently `USER_BAN`, TIER2) is issued on its
 *    own sanctioned route; this aggregate records on the report that it
 *    happened, keeping authority lines clean.
 *  - **Soft delete with attribution** (never a hard delete) — the soft-delete
 *    pattern `phase-07-admin-console.md` scopes for safety + moderation.
 *
 * This is the *aggregate*; the two drivers live in `application/safety/`
 * (`SafetyService` for the guest intake, `AdminSafetyService` for the desk —
 * both TIER1 on the read/dismiss/action verbs, the discipline verbs TIER2 on
 * their own routes, all audited via `admin-authority`'s `record`).
 */

export type SafetyReportStatus = 'open' | 'dismissed' | 'actioned';

export type SafetyReportCategory = 'harassment' | 'spam' | 'inappropriate' | 'safety' | 'other';

/** v1 showed CRITICAL for the `safety` category, NORMAL otherwise — persisted, not displayed. */
export type SafetyReportPriority = 'critical' | 'normal';

export type SafetyReportTargetType = 'user' | 'event' | 'venue' | 'organization';

export interface SafetyReportReporter {
  userId: EntityId;
  /** Captured on the guest intake path when disclosed; null otherwise. */
  email: string | null;
}

export interface SafetyReportTarget {
  type: SafetyReportTargetType;
  id: EntityId;
}

/** Optional submission context — v1's `metadata: {eventId, messageId}`. */
export interface SafetyReportContext {
  eventId: EntityId | null;
  messageId: EntityId | null;
}

export interface SafetyReportAction {
  /** The discipline verb the operator states resolved this report. */
  type: string;
  /** The ban / target id the discipline was applied against. */
  ref: EntityId;
}

export interface SafetyReport extends VersionedEntity {
  id: EntityId;
  reporter: SafetyReportReporter;
  target: SafetyReportTarget;
  category: SafetyReportCategory;
  /** `critical` when the category is `safety`, else `normal` (v1's derivation). */
  priority: SafetyReportPriority;
  details: string | null;
  context: SafetyReportContext;
  status: SafetyReportStatus;
  /** 24h from creation while open — the review promise v1 never recorded. */
  reviewDueAt: string | null;
  dismissedAt: string | null;
  dismissedBy: EntityId | null;
  actionedAt: string | null;
  actionedBy: EntityId | null;
  action: SafetyReportAction | null;
  /** Soft-delete attribution — never a hard delete (see `event.ts`). */
  deletedAt: string | null;
  deletedBy: EntityId | null;
}

export interface CreateSafetyReportInput {
  id: EntityId;
  reporter: SafetyReportReporter;
  target: SafetyReportTarget;
  category: SafetyReportCategory;
  details?: string | null;
  context?: Partial<SafetyReportContext>;
  now?: Date;
}

/** The mobile intake's "we'll review within 24 hours" promise, made real. */
export const SAFETY_REVIEW_HOURS = 24;

export function priorityFor(category: SafetyReportCategory): SafetyReportPriority {
  return category === 'safety' ? 'critical' : 'normal';
}

function hoursFrom(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 60 * 60 * 1000).toISOString();
}

function assertOpen(report: SafetyReport) {
  if (report.deletedAt) throw new InvalidOperationError('This report is deleted');
  if (report.status !== 'open')
    throw new StateTransitionError(report.status, 'dismissed|actioned', 'already resolved');
}

export function createSafetyReport(input: CreateSafetyReportInput): SafetyReport {
  const targetId = input.target.id.trim();
  if (targetId.length === 0) throw new InvalidOperationError('A report requires a target id');
  if (input.reporter.userId.trim().length === 0)
    throw new InvalidOperationError('A report requires a reporter');
  const now = input.now ?? new Date();
  return {
    id: input.id,
    reporter: input.reporter,
    target: { type: input.target.type, id: targetId },
    category: input.category,
    priority: priorityFor(input.category),
    details: input.details?.trim() ?? null,
    context: {
      eventId: input.context?.eventId ?? null,
      messageId: input.context?.messageId ?? null,
    },
    status: 'open',
    reviewDueAt: hoursFrom(now.toISOString(), SAFETY_REVIEW_HOURS),
    dismissedAt: null,
    dismissedBy: null,
    actionedAt: null,
    actionedBy: null,
    action: null,
    deletedAt: null,
    deletedBy: null,
    ...newVersionedEntity(now),
  };
}

/**
 * v1's `SAFETY_REPORT_DISMISS` verb (adminStore.js: status open→dismissed,
 * writes `dismissedAt`/`dismissedBy`/`updatedAt`). A dismissal is a decision —
 * a reason is required, mirroring support's `resolveTicket`.
 */
export function dismissSafetyReport(
  report: SafetyReport,
  dismissedBy: EntityId,
  reason: string,
  now: Date = new Date(),
): SafetyReport {
  if (reason.trim().length === 0)
    throw new InvalidOperationError('Dismissing a report requires a reason');
  assertOpen(report);
  return {
    ...bumpVersion(report, now),
    status: 'dismissed',
    dismissedAt: now.toISOString(),
    dismissedBy,
  };
}

/**
 * Records an operator-stated resolution action on the report (open→actioned).
 * This does *not* issue the discipline verb (e.g. `USER_BAN`) — that stays on
 * its own TIER2 route, `admin/user-actions.ts`; `action` here documents on the
 * report which verb the operator applied and against what. TIER1 to record,
 * audited as `SAFETY_REPORT_ACTION`.
 */
export function actionSafetyReport(
  report: SafetyReport,
  actionedBy: EntityId,
  action: SafetyReportAction,
  reason: string,
  now: Date = new Date(),
): SafetyReport {
  if (reason.trim().length === 0) throw new InvalidOperationError('Resolving requires a reason');
  if (action.type.trim().length === 0 || action.ref.trim().length === 0)
    throw new InvalidOperationError('Actioning a report requires a stated action');
  assertOpen(report);
  return {
    ...bumpVersion(report, now),
    status: 'actioned',
    actionedAt: now.toISOString(),
    actionedBy,
    action,
  };
}

/** Soft delete with attribution — the record stays intact. */
export function deleteSafetyReport(
  report: SafetyReport,
  deletedBy: EntityId,
  now: Date = new Date(),
): SafetyReport {
  if (report.deletedAt) throw new InvalidOperationError('This report is already deleted');
  return {
    ...bumpVersion(report, now),
    deletedAt: now.toISOString(),
    deletedBy,
  };
}

/** Restoration of a soft-deleted report. */
export function restoreSafetyReport(
  report: SafetyReport,
  adminId: EntityId,
  now: Date = new Date(),
): SafetyReport {
  if (!report.deletedAt) throw new InvalidOperationError('This report is not deleted');
  return {
    ...bumpVersion(report, now),
    deletedAt: null,
    deletedBy: null,
  };
}
