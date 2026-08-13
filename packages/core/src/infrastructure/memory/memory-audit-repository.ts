/**
 * ─── In-memory audit repository ───────────────────────────────────────────────
 * B09 consumer sink: `EventPublished`/`EventUpdated` → an audit record.
 * Durable adapter in B12. Zero infra imports.
 */

import type { EntityId } from '../../domain/identity.js';
import type { AuditRecord, AuditRepository } from '../../domain/ports/audit.js';

export class MemoryAuditRepository implements AuditRepository {
  private readonly records: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> {
    // Idempotent by event id: a redelivered row (bus restart) never
    // produces a duplicate audit record.
    if (this.records.some((r) => r.id === record.id)) return;
    this.records.push(record);
  }

  async listByOrganization(organizationId: EntityId, limit: number): Promise<AuditRecord[]> {
    return this.records.filter((record) => record.organizationId === organizationId).slice(-limit);
  }

  /** Test/diagnostic accessor. */
  all(): AuditRecord[] {
    return [...this.records];
  }
}
