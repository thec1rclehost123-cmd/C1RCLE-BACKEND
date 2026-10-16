import { VersionConflictError } from '../../domain/errors.js';

import { paginateQuery, paginateUnordered } from './pagination.js';

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
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';

const RUNS = 'v2_reconciliation_runs';
const DISCREPANCIES = 'v2_reconciliation_discrepancies';

export class FirestoreReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly db: Firestore) {}

  async createRun(run: ReconciliationRun): Promise<void> {
    await this.db.collection(RUNS).doc(run.id).create(run);
  }

  async saveRun(run: ReconciliationRun): Promise<void> {
    await this.saveVersioned(RUNS, run);
  }

  async getRun(id: EntityId): Promise<ReconciliationRun | null> {
    const data = (await this.db.collection(RUNS).doc(id).get()).data();
    return data ? (data as ReconciliationRun) : null;
  }

  async listRuns(query: PaginationQuery): Promise<Page<ReconciliationRun>> {
    return paginateQuery(
      this.db.collection(RUNS).orderBy('startedAt', 'desc'),
      query,
      (data) => data as ReconciliationRun,
    );
  }

  async createDiscrepancies(items: ReconciliationDiscrepancy[]): Promise<void> {
    for (let start = 0; start < items.length; start += 400) {
      const batch = this.db.batch();
      for (const item of items.slice(start, start + 400)) {
        batch.create(this.db.collection(DISCREPANCIES).doc(item.id), item);
      }
      await batch.commit();
    }
  }

  async getDiscrepancy(id: EntityId): Promise<ReconciliationDiscrepancy | null> {
    const data = (await this.db.collection(DISCREPANCIES).doc(id).get()).data();
    return data ? (data as ReconciliationDiscrepancy) : null;
  }

  async saveDiscrepancy(item: ReconciliationDiscrepancy): Promise<void> {
    await this.saveVersioned(DISCREPANCIES, item);
  }

  async listDiscrepancies(
    query: PaginationQuery & {
      runId?: EntityId;
      state?: ReconciliationDiscrepancyState;
      organizationId?: EntityId;
    },
  ): Promise<Page<ReconciliationDiscrepancy>> {
    let base: Query = this.db.collection(DISCREPANCIES);
    if (query.runId) base = base.where('runId', '==', query.runId);
    if (query.state) base = base.where('state', '==', query.state);
    if (query.organizationId) base = base.where('organizationId', '==', query.organizationId);
    return paginateUnordered(base, query, (data) => data as ReconciliationDiscrepancy);
  }

  private async saveVersioned(
    collection: string,
    item: { id: EntityId; version: number },
  ): Promise<void> {
    const ref = this.db.collection(collection).doc(item.id);
    await this.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const actual = (current.data()?.version as number | undefined) ?? 0;
      if (actual !== item.version - 1) throw new VersionConflictError(item.version - 1, actual);
      tx.set(ref, item as DocumentData);
    });
  }
}
