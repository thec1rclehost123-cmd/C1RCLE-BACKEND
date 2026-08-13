/**
 * ─── T13 slice consumers ──────────────────────────────────────────────────────
 * B09 consumers for this slice: domain events → audit records. The future
 * `event.published → projection` consumer is a no-op (wire exists — subscribe
 * a projection handler to `event.published` when projections land).
 */

import type { DomainEvent } from '../../domain/events.js';
import type { AuditRepository } from '../../domain/ports/audit.js';

/** One audit record per delivery — bus dedupe guarantees exactly once. */
export function createAuditConsumer(audits: AuditRepository) {
  return async (event: DomainEvent): Promise<void> => {
    const record = {
      id: event.id,
      organizationId: event.organizationId,
      actorId: event.actorId,
      eventType: event.type,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      snapshot: event.payload,
    };
    await audits.append(record);
  };
}

/** No-op projection consumer — wire exists for the real projection later. */
export function createProjectionConsumer(_event: DomainEvent): Promise<void> {
  return Promise.resolve();
}
