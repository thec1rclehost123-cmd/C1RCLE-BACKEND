/**
 * ─── T13 slice consumers ──────────────────────────────────────────────────────
 * B09 consumers for this slice: domain events → audit records. The
 * `event.* → analytics projection` consumer now lives next to the read model it
 * fills — see `application/analytics/analytics-projection.ts`.
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
