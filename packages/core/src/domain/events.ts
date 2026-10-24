/**
 * ─── T11 versioned domain-event types ─────────────────────────────────────────
 * Events this slice may emit, versioned by `schemaVersion` so consumers can
 * migrate independently. Payloads are plain serializable data — never
 * aggregates, never repo handles. `occurredAt` is epoch ms (backend clock).
 */

import { createHash } from 'node:crypto';

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
  'venue.availability.published': {
    venueId: EntityId;
    startTime: string;
    endTime: string;
    timezone: string;
  };
  'venue.slot_request.created': { venueId: EntityId; slotId: EntityId };
  'venue.slot_request.accepted': { venueId: EntityId; slotId: EntityId };
  'venue.slot_request.rejected': { venueId: EntityId; slotId: EntityId | null };
  'venue.slot_request.cancelled': { venueId: EntityId; slotId: EntityId | null };
  'event.created': { title: string; venueId: EntityId };
  'event.updated': {
    title?: string;
    venueId?: EntityId;
    materialChange?: {
      eventVersion: number;
      previousTitle: string;
      title: string;
      previousStartAt: string;
      startAt: string;
    } | null;
  };
  'event.material_change.batch_requested': {
    eventId: EntityId;
    eventVersion: number;
    previousTitle: string;
    title: string;
    previousStartAt: string;
    startAt: string;
    cursor: string | null;
  };
  'event.material_change.order_affected': {
    eventId: EntityId;
    orderId: EntityId;
    eventVersion: number;
    previousTitle: string;
    title: string;
    previousStartAt: string;
    startAt: string;
  };
  'event.published': { title: string };
  'event.cancelled': { title: string; reason: string; eventVersion: number };
  'event.cancellation.batch_requested': {
    eventId: EntityId;
    reason: string;
    eventVersion: number;
    cursor: string | null;
  };
  'event.cancellation.order_affected': {
    eventId: EntityId;
    orderId: EntityId;
    refundRequestId: EntityId | null;
    reason: string;
  };
  'order.fulfilled': { orderId: EntityId; eventId: EntityId };
  'payment.support_required': {
    paymentId: string;
    holdId: EntityId;
    organizationId: EntityId;
    stateVersion: number;
  };
  'finance.refund.settled': {
    refundRequestId: EntityId;
    orderId: EntityId;
    amountPaise: number;
    providerRefundId: string;
  };
  'finance.refund.finalized': {
    refundRequestId: EntityId;
    orderId: EntityId;
    status: 'rejected' | 'failed';
  };
  'finance.payout.status_changed': {
    payoutId: EntityId;
    organizationId: EntityId;
    status: 'requested' | 'processing' | 'paid' | 'failed' | 'frozen';
    version: number;
    amountPaise: number;
  };
  // Phase 8: follow graph. Consumers: audit; follower-count projections later.
  'follow.created': { followerId: EntityId; targetType: 'venue' | 'host'; targetId: EntityId };
  'follow.removed': { followerId: EntityId; targetType: 'venue' | 'host'; targetId: EntityId };
  /**
   * A promoter (or the converse: a venue/host offering itself to a promoter)
   * opened a connection. `targetId` is the RECIPIENT org — the notification
   * consumer addresses the inbox entry there, not at the event's own
   * `organizationId` (the requester's org). `promoterName` is resolved by the
   * emitter so the consumer never performs a second lookup.
   */
  'promoter_connection.requested': {
    connectionId: EntityId;
    targetId: EntityId;
    targetType: 'host' | 'venue';
    initiatedBy: 'promoter' | 'target';
    promoterId: EntityId;
    promoterName: string;
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

/** Stable outbox identity for logical events that may be ensured repeatedly. */
export function deterministicDomainEventId(type: string, ...parts: string[]): EntityId {
  const digest = createHash('sha256')
    .update([type, ...parts].join(':'))
    .digest('hex');
  return `EVT-${digest.slice(0, 40)}`;
}

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
