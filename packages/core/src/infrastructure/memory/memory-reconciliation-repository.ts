import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ReconciliationDiscrepancy,
  ReconciliationDiscrepancyState,
  ReconciliationRun,
} from '../../domain/models/reconciliation.js';
import type {
  Page,
  PaginationQuery,
  ReconciliationRepository,
} from '../../domain/ports/repositories.js';

function page<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  const start = query.cursor ? all.findIndex((item) => item.id === query.cursor) + 1 : 0;
  const items = all.slice(start, start + query.limit);
  return {
    items: structuredClone(items),
    total: all.length,
    nextCursor: start + items.length < all.length ? (items.at(-1)?.id ?? null) : null,
  };
}

export class MemoryReconciliationRepository implements ReconciliationRepository {
  readonly runs = new Map<EntityId, ReconciliationRun>();
  readonly discrepancies = new Map<EntityId, ReconciliationDiscrepancy>();

  async createRun(run: ReconciliationRun): Promise<void> {
    if (this.runs.has(run.id)) throw new VersionConflictError(0, 1);
    this.runs.set(run.id, structuredClone(run));
  }

  async saveRun(run: ReconciliationRun): Promise<void> {
    const current = this.runs.get(run.id);
    if (!current || current.version !== run.version - 1) {
      throw new VersionConflictError(run.version - 1, current?.version ?? 0);
    }
    this.runs.set(run.id, structuredClone(run));
  }

  async getRun(id: EntityId): Promise<ReconciliationRun | null> {
    const item = this.runs.get(id);
    return item ? structuredClone(item) : null;
  }

  async listRuns(query: PaginationQuery): Promise<Page<ReconciliationRun>> {
    return page(
      [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      query,
    );
  }

  async createDiscrepancies(items: ReconciliationDiscrepancy[]): Promise<void> {
    for (const item of items)
      if (!this.discrepancies.has(item.id)) this.discrepancies.set(item.id, structuredClone(item));
  }

  async getDiscrepancy(id: EntityId): Promise<ReconciliationDiscrepancy | null> {
    const item = this.discrepancies.get(id);
    return item ? structuredClone(item) : null;
  }

  async saveDiscrepancy(item: ReconciliationDiscrepancy): Promise<void> {
    const current = this.discrepancies.get(item.id);
    if (!current || current.version !== item.version - 1) {
      throw new VersionConflictError(item.version - 1, current?.version ?? 0);
    }
    this.discrepancies.set(item.id, structuredClone(item));
  }

  async listDiscrepancies(
    query: PaginationQuery & {
      runId?: EntityId;
      state?: ReconciliationDiscrepancyState;
      organizationId?: EntityId;
    },
  ): Promise<Page<ReconciliationDiscrepancy>> {
    return page(
      [...this.discrepancies.values()]
        .filter((item) => !query.runId || item.runId === query.runId)
        .filter((item) => !query.state || item.state === query.state)
        .filter((item) => !query.organizationId || item.organizationId === query.organizationId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      query,
    );
  }
}
