import { VersionConflictError } from '../../domain/errors.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { SafetyReport, SafetyReportStatus } from '../../domain/models/safety-report.js';
import type {
  Page,
  PaginationQuery,
  SafetyReportQuery,
  SafetyReportRepository,
  SafetyReportStats,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';

const SAFETY_REPORT_COLLECTION = 'v2_safety_reports';

function matchesFilter(report: SafetyReport, query: SafetyReportQuery): boolean {
  const primary: (keyof SafetyReportQuery)[] = ['status', 'category', 'priority'];
  const applied = primary.map((key) => query[key]);
  const remaining = Object.fromEntries(
    Object.entries(query).filter(
      ([key, value]) => !primary.includes(key as keyof SafetyReportQuery) && value !== undefined,
    ),
  ) as Partial<SafetyReportQuery>;
  if (remaining.targetType !== undefined && report.target.type !== remaining.targetType)
    return false;
  if (remaining.reporterUserId !== undefined && report.reporter.userId !== remaining.reporterUserId)
    return false;
  if (!remaining.includeDeleted && report.deletedAt) return false;
  if (remaining.search) {
    const haystack = (report.details ?? '').toLowerCase();
    if (!haystack.includes(remaining.search.toLowerCase())) return false;
  }
  return applied.every((value) => value === undefined);
}

export class FirestoreSafetyReportRepository implements SafetyReportRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(SAFETY_REPORT_COLLECTION);
  }

  async getById(id: EntityId, opts?: { includeDeleted?: boolean }): Promise<SafetyReport | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    if (!data) return null;
    const report = toSafetyReport(data);
    if (report.deletedAt && !opts?.includeDeleted) return null;
    return report;
  }

  async list(query: SafetyReportQuery, pagination: PaginationQuery): Promise<Page<SafetyReport>> {
    // Build a storage-level query off at most ONE equality filter to avoid
    // composite-index sprawl (same convention as the support-ticket adapter —
    // a bare field+`orderBy` composite is the accepted cost). Every remaining
    // filter (target type, reporter, search, soft-delete visibility) is
    // applied over the mapped page in `matchesFilter` — behavior stays
    // identical to the memory adapter, and no new indexes are introduced.
    let base: Query = this.collection;
    if (query.status) base = base.where('status', '==', query.status);
    else if (query.category) base = base.where('category', '==', query.category);
    else if (query.priority) base = base.where('priority', '==', query.priority);
    base = base.orderBy('createdAt', 'desc');

    const page = await paginateQuery(base, pagination, toSafetyReport);
    const items = page.items.filter((report) => matchesFilter(report, query));
    return { items, total: page.total, nextCursor: page.nextCursor };
  }

  async listByReporter(
    reporterUserId: EntityId,
    pagination: PaginationQuery,
  ): Promise<Page<SafetyReport>> {
    const base = this.collection
      .where('reporterUserId', '==', reporterUserId)
      .where('deletedAt', '==', null)
      .orderBy('createdAt', 'desc');
    const page = await paginateQuery(base, pagination, toSafetyReport);
    const items = page.items.filter((report) => report.deletedAt === null);
    return { items, total: page.total, nextCursor: page.nextCursor };
  }

  async stats(): Promise<SafetyReportStats> {
    // Single-equality count aggregations only — a status+priority composite
    // would need a new index, which this repo deliberately avoids. The desk
    // list can still filter priority + open via `matchesFilter`.
    const count = async (query: Query): Promise<number> => {
      const snap = await query.count().get();
      return snap.data().count;
    };
    return {
      open: await count(this.collection.where('status', '==', 'open')),
      dismissed: await count(this.collection.where('status', '==', 'dismissed')),
      actioned: await count(this.collection.where('status', '==', 'actioned')),
      total: await count(this.collection),
      critical: await count(this.collection.where('priority', '==', 'critical')),
    };
  }

  async save(report: SafetyReport): Promise<void> {
    const ref = this.collection.doc(report.id);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data) {
        const existing = toSafetyReport(data);
        if (existing.version !== report.version - 1) {
          throw new VersionConflictError(report.version - 1, existing.version);
        }
      }
      tx.set(ref, toDoc(report));
    });
  }
}

/** Denormalised `reporter.userId`/`target.type` for the single-field queries without an index. */
function toDoc(report: SafetyReport): DocumentData {
  return {
    id: report.id,
    reporterUserId: report.reporter.userId,
    reporter: report.reporter,
    targetType: report.target.type,
    target: report.target,
    category: report.category,
    priority: report.priority,
    details: report.details,
    context: report.context,
    status: report.status,
    reviewDueAt: report.reviewDueAt,
    dismissedAt: report.dismissedAt,
    dismissedBy: report.dismissedBy,
    actionedAt: report.actionedAt,
    actionedBy: report.actionedBy,
    action: report.action,
    deletedAt: report.deletedAt,
    deletedBy: report.deletedBy,
    version: report.version,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

function toSafetyReport(data: DocumentData): SafetyReport {
  return {
    id: data.id as string,
    reporter: data.reporter as SafetyReport['reporter'],
    target: data.target as SafetyReport['target'],
    category: data.category as SafetyReport['category'],
    priority: data.priority as SafetyReport['priority'],
    details: data.details as string | null,
    context: data.context as SafetyReport['context'],
    status: data.status as SafetyReportStatus,
    reviewDueAt: data.reviewDueAt as string | null,
    dismissedAt: data.dismissedAt as string | null,
    dismissedBy: data.dismissedBy as string | null,
    actionedAt: data.actionedAt as string | null,
    actionedBy: data.actionedBy as string | null,
    action: data.action as SafetyReport['action'],
    deletedAt: data.deletedAt as string | null,
    deletedBy: data.deletedBy as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
