/**
 * ─── Versioned domain events (T11) ───────────────────────────────────────────
 * The vocabulary services publish and consumers react to. Every event carries
 * an explicit `schemaVersion` so a consumer can refuse a payload it does not
 * understand instead of silently mis-reading it.
 *
 * Pure data: no transport, no storage, no clock. Services stamp `occurredAt`
 * from their injected clock.
 */

import type { EntityId } from '../identity.js';

export type DomainEventType =
  | 'organization.created'
  | 'organization.updated'
  | 'venue.created'
  | 'venue.updated'
  | 'slot_request.created'
  | 'slot_request.accepted'
  | 'event.created'
  | 'event.updated'
  | 'event.published'
  | 'event.cancelled';

export const DOMAIN_EVENT_TYPES: readonly DomainEventType[] = [
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

export interface DomainEvent<TPayload = Record<string, unknown>> {
  /** Unique id — the dedupe key every consumer must honour. */
  readonly id: EntityId;
  readonly type: DomainEventType;
  readonly schemaVersion: number;
  /** The aggregate this event is about (organization, venue, event, …). */
  readonly aggregateId: EntityId;
  /** Tenant scope; consumers must never cross it. */
  readonly organizationId: EntityId;
  /** Who caused it, for the audit trail. */
  readonly actorId: EntityId;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export interface NewDomainEventInput<TPayload> {
  id: EntityId;
  type: DomainEventType;
  aggregateId: EntityId;
  organizationId: EntityId;
  actorId: EntityId;
  occurredAt: Date;
  payload: TPayload;
  schemaVersion?: number;
}

export function newDomainEvent<TPayload>(
  input: NewDomainEventInput<TPayload>,
): DomainEvent<TPayload> {
  return {
    id: input.id,
    type: input.type,
    schemaVersion: input.schemaVersion ?? 1,
    aggregateId: input.aggregateId,
    organizationId: input.organizationId,
    actorId: input.actorId,
    occurredAt: input.occurredAt.toISOString(),
    payload: input.payload,
  };
}
