/**
 * ─── T12 audit port ───────────────────────────────────────────────────────────
 * Audit writes go through this repository — never directly from a route.
 * Memory-backed for this slice; durable adapter in B12.
 */

import type { EntityId } from '../identity.js';

export interface AuditRecord {
  id: EntityId;
  organizationId: EntityId;
  actorId: EntityId;
  /** Source domain event type, e.g. `event.published`. */
  eventType: string;
  aggregateId: EntityId;
  /** Epoch ms */
  occurredAt: number;
  snapshot: Record<string, unknown>;
}

export interface AuditRepository {
  append(record: AuditRecord): Promise<void>;
  listByOrganization(organizationId: EntityId, limit: number): Promise<AuditRecord[]>;
}
