import { IdempotencyConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { ProviderFinancialEvent } from '../../domain/models/provider-financial-event.js';
import type { ProviderFinancialEventRepository } from '../../domain/ports/repositories.js';

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

export class MemoryProviderFinancialEventRepository implements ProviderFinancialEventRepository {
  readonly events = new Map<EntityId, ProviderFinancialEvent>();
  private readonly byProviderEventId = new Map<string, EntityId>();

  async ingest(event: ProviderFinancialEvent): Promise<ProviderFinancialEvent> {
    const existing = this.events.get(event.id);
    if (existing) {
      if (immutableFacts(existing) !== immutableFacts(event)) {
        throw new IdempotencyConflictError(event.providerEventId);
      }
      return existing;
    }
    const providerEventOwner = this.byProviderEventId.get(event.providerEventId);
    if (providerEventOwner && providerEventOwner !== event.id) {
      throw new IdempotencyConflictError(event.providerEventId);
    }
    this.events.set(event.id, event);
    this.byProviderEventId.set(event.providerEventId, event.id);
    return event;
  }

  async findById(id: EntityId): Promise<ProviderFinancialEvent | null> {
    return this.events.get(id) ?? null;
  }

  async findByProviderEventId(providerEventId: string): Promise<ProviderFinancialEvent | null> {
    const id = this.byProviderEventId.get(providerEventId);
    return id ? (this.events.get(id) ?? null) : null;
  }

  async listByPaymentId(paymentId: string): Promise<ProviderFinancialEvent[]> {
    return [...this.events.values()].filter((event) => event.paymentId === paymentId);
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
    const existing = this.events.get(id);
    if (!existing) return;
    this.events.set(id, {
      ...existing,
      processingState,
      processingAttempts: existing.processingAttempts + 1,
      finalResult,
      processedAt: processedAt.toISOString(),
      version: existing.version + 1,
    });
  }
}
