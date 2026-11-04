import { VersionConflictError, NotFoundError } from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import {
  createProviderFinancialEvent,
  hashProviderEventPayload,
} from '../../domain/models/provider-financial-event.js';
import {
  applyProviderPaymentEvent,
  reconcileOrderWithProvider,
} from '../../domain/models/provider-payment.js';
import { SYSTEM_ACTOR, type ServiceDeps } from '../context.js';

import { FinancialPostingService } from './financial-posting-service.js';

import type { EntityId } from '../../domain/identity.js';
import type { ProviderEventTrust } from '../../domain/models/provider-financial-event.js';
import type {
  ProviderPaymentEvent,
  ReconciliationResult,
} from '../../domain/models/provider-payment.js';

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
  private readonly posting: FinancialPostingService;

  constructor(private deps: ServiceDeps) {
    this.posting = new FinancialPostingService(deps.repositories.financialJournals);
  }

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
      providerOccurredAt:
        event.type === 'captured'
          ? event.occurredAt
          : event.type === 'dispute'
            ? event.providerOccurredAt
            : null,
      payloadHash: context.payloadHash ?? hashProviderEventPayload(JSON.stringify(event)),
      trustedIngestion: context.trustedIngestion ?? 'internal_provider_response',
    });
    const ingested = await this.deps.repositories.providerFinancialEvents.ingest(financialEvent);
    if (ingested.processingState === 'processed') {
      const aggregate = await this.providerPayments.findByPaymentId(event.paymentId);
      const needsPostFulfilmentCorrelation =
        event.type === 'captured' && event.orderId !== null && aggregate?.orderId !== event.orderId;
      if (!needsPostFulfilmentCorrelation) return;
    }
    try {
      let result = await this.applyEvent(event);
      if (event.type === 'dispute') {
        result = `${result}:${await this.applyDisputeFinancialPolicy(event)}`;
        await this.emitPromoterChargebackUpdate(event);
      }
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

  private async applyDisputeFinancialPolicy(
    event: Extract<ProviderPaymentEvent, { type: 'dispute' }>,
  ): Promise<string> {
    const payment = await this.providerPayments.findByPaymentId(event.paymentId);
    if (!payment?.orderId) throw new NotFoundError('order_for_provider_dispute', event.disputeId);
    const order = await this.orders.getById(payment.orderId);
    if (!order || order.paymentId !== event.paymentId) {
      throw new NotFoundError('order_for_provider_dispute', event.disputeId);
    }
    const posting = {
      organizationId: order.organizationId,
      orderId: order.id,
      eventId: order.eventId,
      paymentId: event.paymentId,
      disputeId: event.disputeId,
      amountPaise: event.amountPaise,
      postedAt: this.deps.config.clock.now(),
    };
    if (event.status === 'open' || event.status === 'under_review') {
      await this.posting.postChargebackHold(posting);
      return 'chargeback_hold_posted';
    }
    if (event.status === 'lost' || (event.status === 'closed' && event.amountDeductedPaise > 0)) {
      await this.posting.settleChargebackLoss({
        ...posting,
        providerDeductedPaise: event.amountDeductedPaise || event.amountPaise,
      });
      return 'chargeback_loss_posted';
    }
    await this.posting.releaseChargebackHold(posting);
    return 'chargeback_hold_released';
  }

  private async emitPromoterChargebackUpdate(
    event: Extract<ProviderPaymentEvent, { type: 'dispute' }>,
  ): Promise<void> {
    const payment = await this.providerPayments.findByPaymentId(event.paymentId);
    if (!payment?.orderId) return;
    const order = await this.orders.getById(payment.orderId);
    if (!order?.attribution || order.attribution.promoterCommissionPaise <= 0) return;
    const type = 'finance.chargeback.updated' as const;
    const now = this.deps.config.clock.now().getTime();
    await this.deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId(type, event.disputeId, event.status),
        type,
        aggregateId: order.id,
        organizationId: order.organizationId,
        actorId: SYSTEM_ACTOR.userId,
        payload: { orderId: order.id, disputeId: event.disputeId, status: event.status },
        occurredAt: now,
      }),
    );
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
