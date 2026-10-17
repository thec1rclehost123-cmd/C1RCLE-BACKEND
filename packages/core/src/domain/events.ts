/**
 * ─── T11 versioned domain-event types ─────────────────────────────────────────
 * Events this slice may emit, versioned by `schemaVersion` so consumers can
 * migrate independently. Payloads are plain serializable data — never
 * aggregates, never repo handles. `occurredAt` is epoch ms (backend clock).
 */

import type { EntityId } from './identity.js';

/** Bump when a payload shape changes in a breaking way. */
export const DOMAIN_EVENT_SCHEMA_VERSION = 1;

export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: EntityId;
  type: string;
  schemaVersion: number;
  aggregateId: EntityId;
  organizationId: EntityId;
  actorId: EntityId;
  payload: TPayload;
  /** Epoch ms of the emitting service write (injected clock). */
  occurredAt: number;
}

export interface EventPayloads {
  'organization.created': { name: string; slug: string };
  'organization.updated': { name?: string; slug?: string };
  'venue.created': { name: string; slug: string };
  'venue.updated': { name?: string; slug?: string };
  'event.created': { title: string; venueId: EntityId };
  'event.updated': { title?: string; venueId?: EntityId };
  'event.published': { title: string };
  'event.cancelled': { title: string };
  // Phase 8: follow graph. Consumers: audit; follower-count projections later.
  'follow.created': { followerId: EntityId; targetType: 'venue' | 'host'; targetId: EntityId };
  'follow.removed': { followerId: EntityId; targetType: 'venue' | 'host'; targetId: EntityId };
  /**
   * A promoter (or the converse: a venue/host offering itself to a promoter)
   * opened a connection. `targetId` is the target SIDE of the pair — when
   * `initiatedBy` is `'target'` that side is the initiator, so the consumer
   * must pick the recipient from `initiatedBy` (target side when the promoter
   * opened it, promoter otherwise), never from `targetId` alone. Names are
   * emitter-resolved so the inbox needs no fan-out at read time.
   */
  'promoter_connection.requested': {
    connectionId: EntityId;
    targetId: EntityId;
    targetType: 'host' | 'venue';
    initiatedBy: 'promoter' | 'target';
    promoterId: EntityId;
    promoterName: string;
    targetName: string;
    message: string | null;
  };
  /**
   * A host asked a venue for slot availability (or a venue invited a host).
   * The recipient org is the OTHER party — the notification consumer picks it
   * from `initiatedBy`, never from `organizationId` (the initiator's org).
   * Names are emitter-resolved so the inbox needs no fan-out at read time.
   */
  'partnership.requested': {
    partnershipId: EntityId;
    venueId: EntityId;
    venueOrganizationId: EntityId;
    hostOrganizationId: EntityId;
    initiatedBy: 'host' | 'venue';
    venueName: string;
    hostName: string;
  };
}

export type DomainEventType = keyof EventPayloads;

export interface DomainEventInput<TType extends DomainEventType = DomainEventType> {
  type: TType;
  aggregateId: EntityId;
  organizationId: EntityId;
  actorId: EntityId;
  payload: EventPayloads[TType];
  /** Injected id factory — the emitter supplies it (no random in domain). */
  id: EntityId;
  /** Injected clock — epoch ms. */
  occurredAt: number;
}

/** Builds a canonical versioned domain event. */
export function domainEvent<TType extends DomainEventType>(
  input: DomainEventInput<TType>,
): DomainEvent<EventPayloads[TType]> {
  return {
    id: input.id,
    type: input.type,
    schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
    aggregateId: input.aggregateId,
    organizationId: input.organizationId,
    actorId: input.actorId,
    payload: input.payload,
    occurredAt: input.occurredAt,
  };
}
