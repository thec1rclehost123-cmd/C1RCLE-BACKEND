import { VersionConflictError, NotFoundError } from '../../domain/errors.js';
import {
  applyProviderPaymentEvent,
  reconcileOrderWithProvider,
} from '../../domain/models/provider-payment.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ProviderPaymentEvent,
  ReconciliationResult,
} from '../../domain/models/provider-payment.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/** Webhooks for one payment can land together; a handful of retries is plenty. */
const MAX_ATTEMPTS = 5;

/**
 * ─── Provider payment reconciliation ─────────────────────────────────────────
 *
 * Records what the payment provider reports about each payment and compares it
 * with our orders. It changes no balance and makes no policy decision (see
 * `provider-payment.ts`); it exists so that finance can see, per order, whether
 * the books agree with the provider.
 */
export class ProviderPaymentService {
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

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
  async recordEvent(event: ProviderPaymentEvent): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const existing = await this.providerPayments.findByPaymentId(event.paymentId);
      const next = applyProviderPaymentEvent(existing, event, this.deps.config.clock.now());
      if (next === existing) return;
      try {
        await this.providerPayments.save(next);
        return;
      } catch (error) {
        if (!(error instanceof VersionConflictError) || attempt === MAX_ATTEMPTS) throw error;
      }
    }
  }

  /** Reconciliation for an admin: finance data, so any platform admin may read it. */
  async reconcileOrderForAdmin(
    adminUserId: EntityId,
    orderId: EntityId,
  ): Promise<ReconciliationResult> {
    await this.authority.requireAdmin(adminUserId);
    return this.reconcileOrder(orderId);
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
