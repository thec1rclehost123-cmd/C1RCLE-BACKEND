import type { EntityId } from '../identity.js';

export type EmailDeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface EmailDelivery {
  id: EntityId;
  aggregateId: EntityId;
  kind: string;
  status: EmailDeliveryStatus;
  recipientHash: string;
  retryCount: number;
  providerMessageId: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  lastError: string | null;
  leaseExpiresAt: number | null;
}

export interface EmailDeliveryRepository {
  get(id: EntityId): Promise<EmailDelivery | null>;
  /** Idempotently creates queued evidence before any provider call. */
  createIfAbsent(delivery: EmailDelivery): Promise<EmailDelivery>;
  /** Claims queued/failed or expired sending work; false means already sent/claimed. */
  claim(id: EntityId, now: number, leaseExpiresAt: number): Promise<boolean>;
  markSent(id: EntityId, providerMessageId: string, now: number): Promise<void>;
  markFailed(id: EntityId, safeError: string, now: number): Promise<void>;
  listForAggregate(aggregateId: EntityId, limit?: number): Promise<EmailDelivery[]>;
}
