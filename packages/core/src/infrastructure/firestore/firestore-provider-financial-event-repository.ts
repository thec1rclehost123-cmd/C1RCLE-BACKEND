import { createHash } from 'node:crypto';

import { IdempotencyConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { ProviderFinancialEvent } from '../../domain/models/provider-financial-event.js';
import type { ProviderFinancialEventRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const EVENT_COLLECTION = 'v2_provider_financial_events';
const PROVIDER_ID_COLLECTION = 'v2_provider_financial_event_ids';

function providerEventIndexId(providerEventId: string): string {
  return createHash('sha256').update(providerEventId).digest('hex');
}

function immutableFacts(event: ProviderFinancialEvent): string {
  const {
    processingState: _processingState,
    processingAttempts: _processingAttempts,
    finalResult: _finalResult,
    processedAt: _processedAt,
    version: _version,
    receivedAt: _receivedAt,
    providerOccurredAt: _providerOccurredAt,
    replayOfEventId: _replayOfEventId,
    ...facts
  } = event;
  return JSON.stringify(facts);
}

export class FirestoreProviderFinancialEventRepository implements ProviderFinancialEventRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(EVENT_COLLECTION);
  }

  async ingest(event: ProviderFinancialEvent): Promise<ProviderFinancialEvent> {
    return this.db.runTransaction(async (transaction) => {
      const eventReference = this.collection.doc(event.id);
      const providerIdReference = this.db
        .collection(PROVIDER_ID_COLLECTION)
        .doc(providerEventIndexId(event.providerEventId));
      const [eventSnapshot, providerIdSnapshot] = await Promise.all([
        transaction.get(eventReference),
        transaction.get(providerIdReference),
      ]);
      const existingData = eventSnapshot.data();
      if (existingData) {
        const existing = toEvent(existingData);
        if (immutableFacts(existing) !== immutableFacts(event)) {
          throw new IdempotencyConflictError(event.providerEventId);
        }
        return existing;
      }
      const owner = providerIdSnapshot.data()?.eventId as string | undefined;
      if (owner && owner !== event.id) throw new IdempotencyConflictError(event.providerEventId);
      transaction.create(eventReference, toDoc(event));
      if (!providerIdSnapshot.exists)
        transaction.create(providerIdReference, { eventId: event.id });
      return event;
    });
  }

  async findById(id: EntityId): Promise<ProviderFinancialEvent | null> {
    const snapshot = await this.collection.doc(id).get();
    const data = snapshot.data();
    return data ? toEvent(data) : null;
  }

  async findByProviderEventId(providerEventId: string): Promise<ProviderFinancialEvent | null> {
    const snapshot = await this.db
      .collection(PROVIDER_ID_COLLECTION)
      .doc(providerEventIndexId(providerEventId))
      .get();
    const eventId = snapshot.data()?.eventId as string | undefined;
    return eventId ? this.findById(eventId) : null;
  }

  async listByPaymentId(paymentId: string): Promise<ProviderFinancialEvent[]> {
    const snapshot = await this.collection.where('paymentId', '==', paymentId).get();
    return snapshot.docs.map((document) => toEvent(document.data()));
  }

  markProcessed(id: EntityId, result: string, processedAt: Date): Promise<void> {
    return this.mark(id, 'processed', result, processedAt);
  }

  markSupportRequired(id: EntityId, result: string, processedAt: Date): Promise<void> {
    return this.mark(id, 'support_required', result, processedAt);
  }

  private async mark(
    id: EntityId,
    processingState: ProviderFinancialEvent['processingState'],
    finalResult: string,
    processedAt: Date,
  ): Promise<void> {
    await this.db.runTransaction(async (transaction) => {
      const reference = this.collection.doc(id);
      const snapshot = await transaction.get(reference);
      const data = snapshot.data();
      if (!data) return;
      const existing = toEvent(data);
      transaction.update(reference, {
        processingState,
        processingAttempts: existing.processingAttempts + 1,
        finalResult,
        processedAt: processedAt.toISOString(),
        version: existing.version + 1,
      });
    });
  }
}

function toDoc(event: ProviderFinancialEvent): DocumentData {
  return { ...event };
}

function toEvent(data: DocumentData): ProviderFinancialEvent {
  return {
    id: data.id as string,
    provider: 'razorpay',
    providerEventId: data.providerEventId as string,
    eventType: data.eventType as string,
    paymentId: data.paymentId as string,
    providerOrderId: (data.providerOrderId as string | null) ?? null,
    refundId: (data.refundId as string | null) ?? null,
    disputeId: (data.disputeId as string | null) ?? null,
    receivedAt: data.receivedAt as string,
    providerOccurredAt: (data.providerOccurredAt as string | null) ?? null,
    payloadHash: data.payloadHash as string,
    trustedIngestion: data.trustedIngestion as ProviderFinancialEvent['trustedIngestion'],
    replayOfEventId: (data.replayOfEventId as string | null) ?? null,
    processingState: data.processingState as ProviderFinancialEvent['processingState'],
    processingAttempts: data.processingAttempts as number,
    finalResult: (data.finalResult as string | null) ?? null,
    processedAt: (data.processedAt as string | null) ?? null,
    version: data.version as number,
  };
}
