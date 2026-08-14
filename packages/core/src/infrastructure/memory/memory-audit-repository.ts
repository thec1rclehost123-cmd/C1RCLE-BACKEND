/**
 * ─── In-memory audit repository ───────────────────────────────────────────────
 * B09 consumer sink: `EventPublished`/`EventUpdated` → an audit record.
 * Durable adapter in B12. Zero infra imports.
 */

import type { EntityId } from '../../domain/identity.js';
import type {
  AdminAuditRecord,
  AdminAuditRepository,
  AuditRecord,
  AuditRepository,
} from '../../domain/ports/audit.js';

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

/** In-memory admin audit trail (Phase 2). Durable adapter alongside it. */
export class MemoryAdminAuditRepository implements AdminAuditRepository {
  private readonly records: AdminAuditRecord[] = [];

  async append(record: AdminAuditRecord): Promise<void> {
    if (this.records.some((existing) => existing.id === record.id)) return;
    this.records.push(record);
  }

  async listRecent(limit: number): Promise<AdminAuditRecord[]> {
    return [...this.records].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, limit);
  }

  async listForTarget(targetId: EntityId, limit: number): Promise<AdminAuditRecord[]> {
    return this.records
      .filter((record) => record.targetId === targetId)
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, limit);
  }

  /** Test/diagnostic accessor. */
  all(): AdminAuditRecord[] {
    return [...this.records];
  }
}
