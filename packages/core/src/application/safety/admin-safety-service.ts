import { NotFoundError } from '../../domain/errors.js';
import {
  actionSafetyReport,
  deleteSafetyReport,
  dismissSafetyReport,
  restoreSafetyReport,
} from '../../domain/models/safety-report.js';

import type { EntityId } from '../../domain/identity.js';
import type { SafetyReport, SafetyReportAction } from '../../domain/models/safety-report.js';
import type { AuditRequestMeta } from '../../domain/ports/audit.js';
import type {
  Page,
  PaginationQuery,
  SafetyReportQuery,
  SafetyReportStats,
} from '../../domain/ports/repositories.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Admin safety desk service (Phase 7) ────────────────────────────────────
 *
 * The v1 desk's `safety/page.jsx` verbs (`SAFETY_REPORT_DISMISS`, and the
 * display of reported-user + report listing), re-homed over the real
 * `SafetyReport` aggregate (see `domain/models/safety-report.ts`).
 *
 * Every desk mutation is TIER1 by the `admin-authority.ts` between-tiers
 * rule: any platform admin may review, dismiss, action-record, soft-delete or
 * restore — always logged with before/after state (`SAFETY_REPORT_DISMISS`,
 * `SAFETY_REPORT_ACTION`, `SAFETY_REPORT_DELETE`, `SAFETY_REPORT_RESTORE`
 * live only as *audit actions* here — deliberately not added to `AdminAction`,
 * because TIER1 needs no per-role gate, only the audit trail). The discipline
 * verbs themselves (e.g. `USER_BAN`) remain TIER2 on their own routes —
 * `admin/user-actions.ts` — and `action()` merely records which one the
 * operator applied to this report, with the operator-stated reason.
 *
 * Guest intake (submit / my reports) lives in `routes/v2/safety/intake-routes.ts`.
 */

export interface ActionReportInput {
  action: SafetyReportAction;
  reason: string;
}

export class AdminSafetyService {
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

  private get reports() {
    return this.deps.repositories.safetyReports;
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async listReports(
    adminUserId: EntityId,
    query: SafetyReportQuery,
    pagination: PaginationQuery,
  ): Promise<Page<SafetyReport>> {
    await this.authority.requireAdmin(adminUserId);
    return this.reports.list(query, pagination);
  }

  async getReport(adminUserId: EntityId, reportId: EntityId): Promise<SafetyReport> {
    await this.authority.requireAdmin(adminUserId);
    return this.requireReport(reportId);
  }

  /** The live safety metric — real counts, not v1's fabricated "Safety Rating". */
  async stats(adminUserId: EntityId): Promise<SafetyReportStats> {
    await this.authority.requireAdmin(adminUserId);
    return this.reports.stats();
  }

  // ─── Desk mutations (all TIER1 — any admin, always audited) ──────────────

  /** v1's `SAFETY_REPORT_DISMISS` (open → dismissed, with a required reason). */
  async dismiss(
    adminUserId: EntityId,
    reportId: EntityId,
    reason: string,
    meta?: AuditRequestMeta,
  ): Promise<SafetyReport> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const report = await this.requireReport(reportId);
    const now = this.deps.config.clock.now();
    const updated = dismissSafetyReport(report, adminUserId, reason, now);
    await this.reports.save(updated);
    await this.authority.record(admin, {
      action: 'SAFETY_REPORT_DISMISS',
      targetType: 'safety_report',
      targetId: reportId,
      before: { status: report.status },
      after: { status: updated.status, dismissedAt: updated.dismissedAt },
      reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    this.deps.logger.info('safety.report_dismissed', { reportId });
    return updated;
  }

  /**
   * open → actioned. The discipline verb (e.g. `USER_BAN`) is issued on its
   * own TIER2 route; this records on the report what was stated as applied.
   */
  async action(
    adminUserId: EntityId,
    reportId: EntityId,
    input: ActionReportInput,
    meta?: AuditRequestMeta,
  ): Promise<SafetyReport> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const report = await this.requireReport(reportId);
    const now = this.deps.config.clock.now();
    const updated = actionSafetyReport(report, adminUserId, input.action, input.reason, now);
    await this.reports.save(updated);
    await this.authority.record(admin, {
      action: 'SAFETY_REPORT_ACTION',
      targetType: 'safety_report',
      targetId: reportId,
      before: { status: report.status },
      after: { status: updated.status, actionedAt: updated.actionedAt, action: updated.action },
      reason: input.reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    this.deps.logger.info('safety.report_actioned', { reportId });
    return updated;
  }

  /** Soft delete with attribution — never a hard delete. */
  async delete(
    adminUserId: EntityId,
    reportId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<SafetyReport> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const report = await this.requireReport(reportId);
    const now = this.deps.config.clock.now();
    const updated = deleteSafetyReport(report, adminUserId, now);
    await this.reports.save(updated);
    await this.authority.record(admin, {
      action: 'SAFETY_REPORT_DELETE',
      targetType: 'safety_report',
      targetId: reportId,
      before: { deletedAt: null },
      after: { deletedAt: updated.deletedAt, deletedBy: updated.deletedBy },
      reason: 'Soft-deleted report',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async restore(
    adminUserId: EntityId,
    reportId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<SafetyReport> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const report = await this.requireReportIncludingDeleted(reportId);
    const now = this.deps.config.clock.now();
    const updated = restoreSafetyReport(report, adminUserId, now);
    await this.reports.save(updated);
    await this.authority.record(admin, {
      action: 'SAFETY_REPORT_RESTORE',
      targetType: 'safety_report',
      targetId: reportId,
      before: { deletedAt: report.deletedAt, deletedBy: report.deletedBy },
      after: { deletedAt: null, deletedBy: null },
      reason: 'Restored report',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  private async requireReport(reportId: EntityId): Promise<SafetyReport> {
    const report = await this.reports.getById(reportId);
    if (!report) throw new NotFoundError('safety_report', reportId);
    return report;
  }

  private async requireReportIncludingDeleted(reportId: EntityId): Promise<SafetyReport> {
    const report = await this.reports.getById(reportId, { includeDeleted: true });
    if (!report) throw new NotFoundError('safety_report', reportId);
    return report;
  }
}
