import { VersionConflictError } from '../../domain/errors.js';
import { createReconciliation } from '../../domain/models/cover-wallet-reconciliation.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  CoverWalletReconciliation,
  CoverWalletReconciliationCreateInput,
  ReconciliationStatus,
} from '../../domain/models/cover-wallet-reconciliation.js';
import type {
  CoverWalletReconciliationRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';

function casSet<T extends { id: EntityId; version: number }>(
  map: Map<EntityId, T>,
  entity: T,
): void {
  const existing = map.get(entity.id);
  if (existing && existing.version !== entity.version - 1) {
    throw new VersionConflictError(entity.version - 1, existing.version);
  }
  map.set(entity.id, entity);
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

export class MemoryCoverWalletReconciliationRepository implements CoverWalletReconciliationRepository {
  reconciliations = new Map<EntityId, CoverWalletReconciliation>();

  async create(input: CoverWalletReconciliationCreateInput): Promise<CoverWalletReconciliation> {
    // Check for existing reconciliation for same event and date
    const existing = await this.findByEventAndDate(input.eventId, input.reconciliationDate);
    if (existing) {
      throw new Error('Reconciliation already exists');
    }
    const recon = createReconciliation(input);
    casSet(this.reconciliations, recon);
    return recon;
  }

  async findById(id: EntityId): Promise<CoverWalletReconciliation | null> {
    return this.reconciliations.get(id) ?? null;
  }

  async findByEventAndDate(
    eventId: EntityId,
    date: string,
  ): Promise<CoverWalletReconciliation | null> {
    for (const r of this.reconciliations.values()) {
      if (r.eventId === eventId && r.reconciliationDate === date) return r;
    }
    return null;
  }

  async findByEvent(
    eventId: EntityId,
    input: PaginationQuery,
  ): Promise<Page<CoverWalletReconciliation>> {
    const all = [...this.reconciliations.values()].filter((r) => r.eventId === eventId);
    return serializeSlice(all, input);
  }

  async findByOrganization(
    organizationId: EntityId,
    input: PaginationQuery,
  ): Promise<Page<CoverWalletReconciliation>> {
    const all = [...this.reconciliations.values()].filter(
      (r) => r.organizationId === organizationId,
    );
    return serializeSlice(all, input);
  }

  async findPending(organizationId: EntityId): Promise<CoverWalletReconciliation[]> {
    return [...this.reconciliations.values()].filter(
      (r) => r.organizationId === organizationId && r.status === 'pending',
    );
  }

  async findWithDiscrepancies(organizationId: EntityId): Promise<CoverWalletReconciliation[]> {
    return [...this.reconciliations.values()].filter(
      (r) => r.organizationId === organizationId && r.discrepancies.length > 0,
    );
  }

  async resolve(
    id: EntityId,
    resolvedBy: EntityId,
    notes: string,
  ): Promise<CoverWalletReconciliation | null> {
    const r = this.reconciliations.get(id);
    if (!r) return null;
    const updated = {
      ...r,
      status: 'resolved' as ReconciliationStatus,
      resolvedBy,
      resolvedAt: new Date().toISOString(),
      resolutionNotes: notes,
      version: r.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.reconciliations.set(id, updated);
    return updated;
  }

  async getOrganizationStats(
    organizationId: EntityId,
    from: Date,
    to: Date,
  ): Promise<{
    totalReconciliations: number;
    completedCount: number;
    discrepancyCount: number;
    resolvedCount: number;
    totalDiscrepancyAmount: number;
  }> {
    const all = [...this.reconciliations.values()].filter(
      (r) =>
        r.organizationId === organizationId &&
        new Date(r.createdAt) >= from &&
        new Date(r.createdAt) <= to,
    );
    return {
      totalReconciliations: all.length,
      completedCount: all.filter((r) => r.status === 'completed').length,
      discrepancyCount: all.filter((r) => r.status === 'discrepancy').length,
      resolvedCount: all.filter((r) => r.status === 'resolved').length,
      totalDiscrepancyAmount: all.reduce((sum, r) => sum + Math.abs(r.discrepancy), 0),
    };
  }
}
