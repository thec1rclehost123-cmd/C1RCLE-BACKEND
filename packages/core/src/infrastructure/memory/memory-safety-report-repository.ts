import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { SafetyReport } from '../../domain/models/safety-report.js';
import type {
  Page,
  PaginationQuery,
  SafetyReportQuery,
  SafetyReportRepository,
  SafetyReportStats,
} from '../../domain/ports/repositories.js';

function matches(report: SafetyReport, query: SafetyReportQuery): boolean {
  if (query.status !== undefined && report.status !== query.status) return false;
  if (query.category !== undefined && report.category !== query.category) return false;
  if (query.priority !== undefined && report.priority !== query.priority) return false;
  if (query.targetType !== undefined && report.target.type !== query.targetType) return false;
  if (query.reporterUserId !== undefined && report.reporter.userId !== query.reporterUserId)
    return false;
  if (!query.includeDeleted && report.deletedAt) return false;
  if (query.search) {
    const haystack = (report.details ?? '').toLowerCase();
    if (!haystack.includes(query.search.toLowerCase())) return false;
  }
  return true;
}

function serializeSlice<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const last = items[items.length - 1];
  const nextCursor = end < all.length && last ? last.id : null;
  return { items, total: all.length, nextCursor };
}

export class MemorySafetyReportRepository implements SafetyReportRepository {
  reports = new Map<EntityId, SafetyReport>();

  async getById(id: EntityId, opts?: { includeDeleted?: boolean }): Promise<SafetyReport | null> {
    const report = this.reports.get(id) ?? null;
    if (report && report.deletedAt && !opts?.includeDeleted) return null;
    return report;
  }

  async list(query: SafetyReportQuery, pagination: PaginationQuery): Promise<Page<SafetyReport>> {
    const all = [...this.reports.values()]
      .filter((r) => matches(r, query))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return serializeSlice(all, pagination);
  }

  async listByReporter(
    reporterUserId: EntityId,
    pagination: PaginationQuery,
  ): Promise<Page<SafetyReport>> {
    const all = [...this.reports.values()]
      .filter((r) => r.reporter.userId === reporterUserId && !r.deletedAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return serializeSlice(all, pagination);
  }

  async stats(): Promise<SafetyReportStats> {
    const all = [...this.reports.values()].filter((r) => !r.deletedAt);
    return {
      open: all.filter((r) => r.status === 'open').length,
      dismissed: all.filter((r) => r.status === 'dismissed').length,
      actioned: all.filter((r) => r.status === 'actioned').length,
      total: all.length,
      critical: all.filter((r) => r.priority === 'critical').length,
    };
  }

  async save(report: SafetyReport): Promise<void> {
    const existing = this.reports.get(report.id);
    if (existing && existing.version !== report.version - 1) {
      throw new VersionConflictError(report.version - 1, existing.version);
    }
    this.reports.set(report.id, report);
  }
}
