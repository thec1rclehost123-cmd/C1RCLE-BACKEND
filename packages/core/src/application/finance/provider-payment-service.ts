import { VersionConflictError, NotFoundError } from '../../domain/errors.js';
import {
  createProviderFinancialEvent,
  hashProviderEventPayload,
} from '../../domain/models/provider-financial-event.js';
import {
  applyProviderPaymentEvent,
  reconcileOrderWithProvider,
} from '../../domain/models/provider-payment.js';

import type { EntityId } from '../../domain/identity.js';
import type { ProviderEventTrust } from '../../domain/models/provider-financial-event.js';
import type {
  ProviderPaymentEvent,
  ReconciliationResult,
} from '../../domain/models/provider-payment.js';
import type { ServiceDeps } from '../context.js';

/** Webhooks for one payment can land together; a handful of retries is plenty. */
const MAX_ATTEMPTS = 5;

export interface ProviderEventIngestionContext {
  providerEventId?: string | null;
  payloadHash?: string;
  trustedIngestion?: ProviderEventTrust;
  receivedAt?: Date;
}

/**
 * ─── Provider payment reconciliation ─────────────────────────────────────────
 *
 * Records what the payment provider reports about each payment and compares it
 * with our orders. It changes no balance and makes no policy decision (see
 * `provider-payment.ts`); it exists so that finance can see, per order, whether
 * the books agree with the provider.
 */
export class ProviderPaymentService {
  constructor(private deps: ServiceDeps) {}

  private get providerPayments() {
    return this.deps.repositories.providerPayments;
  }

  private get orders() {
    return this.deps.repositories.orders;
  }

  /**
   * Applies one provider event. Idempotent (a replay writes nothing) and safe
   * against two webhooks for the same payment racing: the loser re-reads and
   * re-applies on top of the winner.
   */
  async recordEvent(
    event: ProviderPaymentEvent,
    context: ProviderEventIngestionContext = {},
  ): Promise<void> {
    const receivedAt = context.receivedAt ?? this.deps.config.clock.now();
    const financialEvent = createProviderFinancialEvent({
      providerEventId: context.providerEventId,
      eventType: event.type,
      paymentId: event.paymentId,
      providerOrderId: event.type === 'captured' ? event.providerOrderId : null,
      refundId: event.type === 'refund_processed' ? event.refundId : null,
      disputeId: event.type === 'dispute' ? event.disputeId : null,
      receivedAt,
      providerOccurredAt: event.type === 'captured' ? event.occurredAt : null,
      payloadHash: context.payloadHash ?? hashProviderEventPayload(JSON.stringify(event)),
      trustedIngestion: context.trustedIngestion ?? 'internal_provider_response',
    });
    const ingested = await this.deps.repositories.providerFinancialEvents.ingest(financialEvent);
    try {
      const result = await this.applyEvent(event);
      await this.deps.repositories.providerFinancialEvents.markProcessed(
        ingested.id,
        result,
        this.deps.config.clock.now(),
      );
    } catch (error) {
      await this.deps.repositories.providerFinancialEvents.markSupportRequired(
        ingested.id,
        error instanceof Error ? error.message.slice(0, 500) : 'provider event processing failed',
        this.deps.config.clock.now(),
      );
      throw error;
    }
  }

  private async applyEvent(event: ProviderPaymentEvent): Promise<string> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const existing = await this.providerPayments.findByPaymentId(event.paymentId);
      const next = applyProviderPaymentEvent(existing, event, this.deps.config.clock.now());
      if (next === existing) return 'idempotent_replay';
      try {
        await this.providerPayments.save(next);
        return 'provider_aggregate_updated';
      } catch (error) {
        if (!(error instanceof VersionConflictError) || attempt === MAX_ATTEMPTS) throw error;
      }
    }
    return 'support_required';
  }

  async reconcileOrder(orderId: EntityId): Promise<ReconciliationResult> {
    const order = await this.orders.getById(orderId);
    if (!order) throw new NotFoundError('order', orderId);
    const payment = order.paymentId
      ? await this.providerPayments.findByPaymentId(order.paymentId)
      : null;
    return reconcileOrderWithProvider(order, payment);
  }
}
