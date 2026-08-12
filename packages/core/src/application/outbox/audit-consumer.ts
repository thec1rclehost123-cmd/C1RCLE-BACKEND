import type { EventBus } from './event-bus.js';
import type { DomainEventType } from '../../domain/events/domain-events.js';
import type { AuditRepository } from '../../domain/ports/outbox.js';

/**
 * ─── Audit consumer (T12) ────────────────────────────────────────────────────
 * Rule 13: audit writes go through the `AuditRepository`, never from a route.
 * This consumer turns domain events into the immutable audit trail — one
 * record per event, exactly once, because the bus refuses to re-deliver an
 * event a consumer already handled.
 */

export const AUDIT_CONSUMER = 'audit';

/** Every event that must leave an audit trace. */
export const AUDITED_EVENTS: readonly DomainEventType[] = [
  'organization.created',
  'organization.updated',
  'venue.created',
  'venue.updated',
  'slot_request.created',
  'slot_request.accepted',
  'event.created',
  'event.updated',
  'event.published',
  'event.cancelled',
];

export function registerAuditConsumer(bus: EventBus, audit: AuditRepository): void {
  bus.subscribe(AUDIT_CONSUMER, AUDITED_EVENTS, async (event) => {
    await audit.append({
      // The event id is the audit id: replaying an event cannot fork the trail.
      id: event.id,
      organizationId: event.organizationId,
      actorId: event.actorId,
      action: event.type,
      resourceId: event.aggregateId,
      recordedAt: event.occurredAt,
      metadata: { schemaVersion: event.schemaVersion, ...event.payload },
    });
  });
}
