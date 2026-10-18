import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';

import type { EntityId } from '../identity.js';

export type ProviderEventTrust = 'signature_verified' | 'internal_provider_response';
export type ProviderEventProcessingState = 'pending' | 'processed' | 'support_required';

/**
 * Immutable provider facts plus narrowly mutable processing metadata. Raw
 * webhook payloads are deliberately excluded: the hash proves identity while
 * payment/refund/dispute ids retain the evidence needed for reconciliation.
 */
export interface ProviderFinancialEvent {
  readonly id: EntityId;
  readonly provider: 'razorpay';
  readonly providerEventId: string;
  readonly eventType: string;
  readonly paymentId: string;
  readonly providerOrderId: string | null;
  readonly refundId: string | null;
  readonly disputeId: string | null;
  readonly receivedAt: string;
  readonly providerOccurredAt: string | null;
  readonly payloadHash: string;
  readonly trustedIngestion: ProviderEventTrust;
  readonly replayOfEventId: EntityId | null;
  readonly processingState: ProviderEventProcessingState;
  readonly processingAttempts: number;
  readonly finalResult: string | null;
  readonly processedAt: string | null;
  readonly version: number;
}

export interface CreateProviderFinancialEventInput {
  providerEventId?: string | null;
  eventType: string;
  paymentId: string;
  providerOrderId?: string | null;
  refundId?: string | null;
  disputeId?: string | null;
  receivedAt: Date;
  providerOccurredAt?: string | null;
  payloadHash: string;
  trustedIngestion: ProviderEventTrust;
  replayOfEventId?: EntityId | null;
}

export function providerFinancialEventId(input: {
  eventType: string;
  paymentId: string;
  refundId?: string | null;
  disputeId?: string | null;
  payloadHash: string;
}): EntityId {
  const objectId = input.refundId ?? input.disputeId ?? input.paymentId;
  const digest = createHash('sha256')
    .update(`${input.eventType}:${objectId}:${input.payloadHash}`)
    .digest('hex')
    .slice(0, 32);
  return `pfe-${digest}`;
}

export function createProviderFinancialEvent(
  input: CreateProviderFinancialEventInput,
): ProviderFinancialEvent {
  if (!/^[a-f0-9]{64}$/i.test(input.payloadHash)) {
    throw new InvalidOperationError('Provider event payload hash must be SHA-256 hex');
  }
  if (!input.eventType.trim() || !input.paymentId.trim()) {
    throw new InvalidOperationError('Provider event type and payment id are required');
  }
  const id = providerFinancialEventId(input);
  const suppliedProviderEventId = input.providerEventId?.trim();
  return Object.freeze({
    id,
    provider: 'razorpay' as const,
    providerEventId:
      suppliedProviderEventId === undefined || suppliedProviderEventId === ''
        ? id
        : suppliedProviderEventId,
    eventType: input.eventType,
    paymentId: input.paymentId,
    providerOrderId: input.providerOrderId ?? null,
    refundId: input.refundId ?? null,
    disputeId: input.disputeId ?? null,
    receivedAt: input.receivedAt.toISOString(),
    providerOccurredAt: input.providerOccurredAt ?? null,
    payloadHash: input.payloadHash.toLowerCase(),
    trustedIngestion: input.trustedIngestion,
    replayOfEventId: input.replayOfEventId ?? null,
    processingState: 'pending' as const,
    processingAttempts: 0,
    finalResult: null,
    processedAt: null,
    version: 1,
  });
}

export function hashProviderEventPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}
