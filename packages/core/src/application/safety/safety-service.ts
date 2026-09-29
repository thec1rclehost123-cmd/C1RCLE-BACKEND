import { NotFoundError } from '../../domain/errors.js';
import { createSafetyReport } from '../../domain/models/safety-report.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  SafetyReport,
  SafetyReportCategory,
  SafetyReportTargetType,
} from '../../domain/models/safety-report.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Guest safety intake service (Phase 7) ───────────────────────────────────
 * The reporting surface v1's `/api/v1/social/report` provided (mobile
 * `/social/report` → `{ targetId, targetType, reason/category, details,
 * metadata:{eventId,messageId} }`), re-homed over the `SafetyReport`
 * aggregate. A signed-in guest submits a report and follows up on their own
 * reports; no admin authority is required — `requireUserId` at the route is
 * the only gate, and every method scopes to the reporter's own userId (a read
 * of someone else's report is a 404, never a security hint).
 *
 * The desk side (`AdminSafetyService`) reviews, dismisses, action records and
 * soft-deletes these aggregates; both drive `safety-report.ts`.
 */

export interface SubmitSafetyReportCommand {
  targetType: SafetyReportTargetType;
  targetId: EntityId;
  category: SafetyReportCategory;
  /** Optional free-text context — v1's `details`. */
  details: string | null;
  /** Present on the guest intake path when disclosed; null otherwise. */
  email: string | null;
  /** Optional submission context — v1's `metadata: {eventId, messageId}`. */
  eventId: EntityId | null;
  messageId: EntityId | null;
}

export class SafetyService {
  constructor(private deps: ServiceDeps) {}

  private get reports() {
    return this.deps.repositories.safetyReports;
  }

  async submitReport(reporterUserId: EntityId, command: SubmitSafetyReportCommand) {
    const now = this.deps.config.clock.now();
    const report = createSafetyReport({
      id: this.deps.config.ids(),
      reporter: { userId: reporterUserId, email: command.email },
      target: { type: command.targetType, id: command.targetId },
      category: command.category,
      details: command.details,
      context: { eventId: command.eventId, messageId: command.messageId },
      now,
    });
    await this.reports.save(report);
    this.deps.logger.info('safety.report_submitted', {
      reportId: report.id,
      targetType: report.target.type,
      category: report.category,
      priority: report.priority,
      reporterUserId,
    });
    return report;
  }

  async listMyReports(reporterUserId: EntityId, query: PaginationQuery) {
    return this.reports.listByReporter(reporterUserId, query);
  }

  async getMyReport(reporterUserId: EntityId, reportId: EntityId): Promise<SafetyReport> {
    const report = await this.reports.getById(reportId);
    if (!report || report.deletedAt) throw new NotFoundError('safety_report', reportId);
    if (report.reporter.userId !== reporterUserId) {
      // Do not reveal the report exists for another reporter.
      throw new NotFoundError('safety_report', reportId);
    }
    return report;
  }
}
