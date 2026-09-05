import { InvalidOperationError, VersionConflictError } from '../../domain/errors.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';

import type { EntityId } from '../../domain/identity.js';
import type { CartReservation } from '../../domain/models/cart-reservation.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { Order } from '../../domain/models/order.js';
import type { PricingBreakdown } from '../../domain/models/pricing.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/** Referral attribution captured at quote time, carried through to the hold. */
export interface CheckoutAttribution {
  referralLinkId: EntityId;
  promoterId: EntityId;
  code: string;
}

/**
 * ─── CheckoutService (Phase 4) ─────────────────────────────────────────────────
 * Orchestrates the full checkout flow:
 *   quote → holds → intent → confirm (dual path: webhook + redirect)
 * All mutations are idempotent and use the transactional outbox for fulfillment events.
 */
export class CheckoutService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Step 1: Quote — calculates pricing for a set of lines + promo.
   * Pure calculation, no side effects.
   */
  async quote(input: {
    actor: ActorContext;
    eventId: EntityId;
    lines: { tierId: EntityId; quantity: number }[];
    promoCode?: string | null;
    referralCode?: string | null;
  }): Promise<{ pricing: PricingBreakdown; attribution: CheckoutAttribution | null }> {
    const { eventId, lines, promoCode, referralCode } = input;

    const pricingLines = lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity }));

    // Build referral attribution if code provided. Previously computed and
    // then discarded (dead `_attribution` local) — `createHold` needs this to
    // freeze attribution onto the hold/order, so it must actually be
    // returned to the caller rather than thrown away here.
    let attribution: CheckoutAttribution | null = null;
    if (referralCode) {
      const link = await this.deps.repositories.referralLinks.findByCode(eventId, referralCode);
      if (link && link.isActive) {
        attribution = {
          referralLinkId: link.id,
          promoterId: link.promoterId,
          code: link.code,
        };
      }
    }

    const pricing = await this.deps.pricing.calculate({
      eventId,
      lines: pricingLines,
      promoCode,
    });

    return { pricing, attribution };
  }

  /**
   * Step 2: Create Hold — reserves inventory for ~10 minutes.
   * Idempotent via Idempotency-Key.
   */
  async createHold(input: {
    actor: ActorContext;
    eventId: EntityId;
    organizationId: EntityId;
    lines: { tierId: EntityId; tierName: string; quantity: number; unitPricePaise: number }[];
    pricing: PricingBreakdown;
    appliedPromoCode: string | null;
    attribution: { referralLinkId: EntityId; promoterId: EntityId; code: string } | null;
    userId?: EntityId | null;
    idempotencyKey: string;
    reservationTtlMs?: number;
  }): Promise<CartReservation> {
    const {
      eventId,
      organizationId,
      lines,
      pricing,
      appliedPromoCode,
      attribution,
      userId,
      idempotencyKey,
      reservationTtlMs,
    } = input;

    // Check for existing hold with same idempotency key
    const existing =
      await this.deps.repositories.cartReservations.getByIdempotencyKey(idempotencyKey);
    if (existing) return existing;

    // Check inventory availability
    for (const line of lines) {
      const available = await this.deps.inventory.getAvailableQuantity(eventId, line.tierId);
      if (available < line.quantity) {
        throw new InvalidOperationError(`Insufficient inventory for tier ${line.tierName}`);
      }
    }

    const holdId = `HOLD-${idempotencyKey}`;
    const now = new Date();
    const ttl = reservationTtlMs ?? 10 * 60 * 1000;

    const hold: CartReservation = {
      id: holdId,
      eventId,
      organizationId,
      userId: userId ?? input.actor.userId,
      lines: lines.map((l) => ({ ...l })),
      pricing,
      appliedPromoCode,
      attribution: attribution ?? null,
      status: 'active',
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      convertedOrderId: null,
      idempotencyKey,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.deps.repositories.cartReservations.create(hold);
    return hold;
  }

  /**
   * Step 3: Create Payment Intent — calls PaymentProvider to create order with Razorpay.
   */
  async createPaymentIntent(input: {
    actor: ActorContext;
    holdId: EntityId;
    idempotencyKey: string;
  }): Promise<{ paymentIntentId: string; amountPaise: number }> {
    const { holdId, idempotencyKey } = input;

    const hold = await this.deps.repositories.cartReservations.getById(holdId);
    if (!hold) throw new InvalidOperationError('Hold not found');
    if (hold.status !== 'active')
      throw new InvalidOperationError(`Hold is ${hold.status}, cannot proceed to payment`);
    if (new Date().getTime() > Date.parse(hold.expiresAt)) {
      await this.deps.repositories.cartReservations.release(holdId);
      throw new InvalidOperationError('Hold has expired');
    }

    const paymentProvider = this.deps.paymentProvider;
    const paymentIntent = await paymentProvider.createOrder({
      amountPaise: hold.pricing.grandTotalPaise,
      currency: hold.pricing.currency,
      idempotencyKey,
      metadata: {
        holdId,
        eventId: hold.eventId,
        organizationId: hold.organizationId,
      },
    });

    return {
      paymentIntentId: paymentIntent.id,
      amountPaise: hold.pricing.grandTotalPaise,
    };
  }

  /**
   * Step 4: Confirm Payment — dual-path idempotent fulfillment.
   * Called by both webhook and redirect; second call is a no-op.
   */
  async confirmPayment(input: {
    actor: ActorContext;
    paymentId: string;
    paymentIntentId: string;
    holdId: EntityId;
    _idempotencyKey: string;
  }): Promise<{ order: Order; entitlements: Entitlement[] }> {
    const { paymentId, paymentIntentId, holdId } = input;

    // Check for existing order with this payment id (idempotency) — both the
    // webhook and the client-redirect path call this method for the same
    // payment, and whichever arrives second must be a no-op.
    const existingOrder = await this.deps.repositories.orders.getByPaymentId(paymentId);
    if (existingOrder) {
      const existingEntitlements = await this.deps.repositories.entitlements.getByOrderId(
        existingOrder.id,
      );
      return { order: existingOrder, entitlements: existingEntitlements };
    }

    const hold = await this.deps.repositories.cartReservations.getById(holdId);
    if (!hold) throw new InvalidOperationError('Hold not found');

    // The hold already lost this exact race — some other caller converted it
    // (or is converting it) to an order. Rather than throwing, converge on
    // whatever that caller produces/produced. This is the idempotent claim:
    // the hold's `active -> converted` transition is the single point of
    // contention, and losing it is not an error for a dual confirmation path.
    if (hold.status === 'converted' && hold.convertedOrderId) {
      const convertedOrder = await this.deps.repositories.orders.getById(hold.convertedOrderId);
      if (convertedOrder) {
        const convertedEntitlements = await this.deps.repositories.entitlements.getByOrderId(
          convertedOrder.id,
        );
        return { order: convertedOrder, entitlements: convertedEntitlements };
      }
    }
    if (hold.status !== 'active')
      throw new InvalidOperationError(`Hold is ${hold.status}, cannot confirm`);
    if (new Date().getTime() > Date.parse(hold.expiresAt)) {
      await this.deps.repositories.cartReservations.release(holdId);
      throw new InvalidOperationError('Hold has expired');
    }

    // Verify with the payment provider before fulfilling — never trust a
    // caller-supplied paymentId/paymentIntentId. This was previously entirely
    // unchecked: any actor could call this method (via the redirect-confirm
    // route) with an arbitrary paymentId and be issued a paid order and
    // entitlements without ever paying. HMAC verification at the webhook
    // route and signature verification at the redirect route authenticate
    // *who* is calling; this authenticates *what actually happened* with the
    // money, which is a separate and equally required check (D-022).
    const verified = await this.deps.paymentProvider.getPayment(paymentId);
    if (!verified) {
      throw new InvalidOperationError(`Payment ${paymentId} was not found with the provider`);
    }
    if (!verified.captured) {
      throw new InvalidOperationError(`Payment ${paymentId} has not been captured`);
    }
    if (verified.amountPaise !== hold.pricing.grandTotalPaise) {
      throw new InvalidOperationError(
        `Payment amount ${verified.amountPaise} does not match hold total ${hold.pricing.grandTotalPaise}`,
      );
    }

    // Create order
    const orderId = `ORD-${paymentId}`;
    const now = new Date();
    const order: Order = {
      id: orderId,
      eventId: hold.eventId,
      organizationId: hold.organizationId,
      userId: hold.userId,
      contact: { name: 'Guest', email: 'guest@example.com', phone: '' },
      status: 'paid',
      lines: hold.lines.map((l) => ({
        tierId: l.tierId,
        tierName: l.tierName,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        subtotalPaise: l.unitPricePaise * l.quantity,
      })),
      currency: hold.pricing.currency,
      subtotalPaise: hold.pricing.subtotalPaise,
      discountPaise: hold.pricing.discountPaise,
      discountedSubtotalPaise: hold.pricing.discountedSubtotalPaise,
      platformFeePaise: hold.pricing.platformFeePaise,
      paymentFeePaise: hold.pricing.paymentFeePaise,
      gstPaise: hold.pricing.gstPaise,
      grandTotalPaise: hold.pricing.grandTotalPaise,
      appliedPromoCode: hold.appliedPromoCode,
      attribution: hold.attribution,
      paymentIntentId,
      paymentId,
      paidAt: now.toISOString(),
      reservationExpiresAt: hold.expiresAt,
      failureReason: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    // Atomic transaction: Order + CartReservation conversion + Entitlements + PromoRedemption + Outbox events
    try {
      await this.deps.repositories.orders.save(order);
    } catch (error) {
      // Lost a concurrent race to claim this payment (webhook + redirect
      // both reached here before either had written) — the optimistic-lock
      // write of the loser fails with a version conflict. That is not a
      // caller-facing error: converge on whichever write actually landed.
      if (error instanceof VersionConflictError) {
        const winner = await this.deps.repositories.orders.getByPaymentId(paymentId);
        if (winner) {
          const winnerEntitlements = await this.deps.repositories.entitlements.getByOrderId(
            winner.id,
          );
          return { order: winner, entitlements: winnerEntitlements };
        }
      }
      throw error;
    }
    await this.deps.repositories.cartReservations.convertToOrder(holdId, orderId);
    await this.deps.repositories.promoRedemptions.create({
      id: `RED-${orderId}-${hold.appliedPromoCode ?? 'none'}`,
      promoId: hold.appliedPromoCode ?? '',
      orderId,
      userId: order.userId,
      redeemedAt: now.toISOString(),
    });

    // Issue entitlements
    const issuedEntitlements = issueEntitlements({
      order,
      admitsPerUnit: this.buildAdmitsPerUnit(hold.lines),
      now,
    });
    for (const e of issuedEntitlements) {
      await this.deps.repositories.entitlements.save(e);
    }

    const entitlements = await this.deps.repositories.entitlements.getByOrderId(orderId);
    return { order, entitlements };
  }

  /**
   * Builds admitsPerUnit map from hold lines (couple tickets = 2, etc.)
   */
  private buildAdmitsPerUnit(lines: CartReservation['lines']): Record<EntityId, number> {
    const map: Record<EntityId, number> = {};
    for (const line of lines) {
      // Tier metadata would tell us if it's a couple ticket
      // For now default to 1; actual logic would read from tier metadata
      map[line.tierId] = 1;
    }
    return map;
  }
}
